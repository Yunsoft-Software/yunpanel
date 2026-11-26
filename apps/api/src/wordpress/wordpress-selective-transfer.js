import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { assertUuid, DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const TABLE_PREFIX_PATTERN = /^[a-zA-Z0-9_]{1,32}$/;
const TABLE_NAME_PATTERN = /^[a-zA-Z0-9_]{1,64}$/;
const POST_TYPE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const HEALTH_PATH_PATTERN = /^\/[A-Za-z0-9._/-]{0,127}$/;

const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const ALLOWED_FILE_SCOPES = Object.freeze(['themes', 'plugins', 'mu-plugins', 'custom']);
const ALLOWED_FILE_SCOPE_SET = new Set(ALLOWED_FILE_SCOPES);

const ALWAYS_PROTECTED_FILENAMES = Object.freeze(['wp-config.php', '.htaccess', '.user.ini']);
const ALWAYS_PROTECTED_FILENAME_SET = new Set(ALWAYS_PROTECTED_FILENAMES);
const UPLOADS_PREFIX = 'wp-content/uploads';

const LIVE_COMMERCE_POST_TYPES = Object.freeze([
  'shop_order',
  'shop_order_placehold',
  'shop_order_refund',
  'shop_subscription',
]);
const LIVE_COMMERCE_POST_TYPE_SET = new Set(LIVE_COMMERCE_POST_TYPES);

const MULTISITE_TABLE_SUFFIXES = new Set([
  'blogs',
  'blogmeta',
  'registration_log',
  'signups',
  'site',
  'sitemeta',
]);

const PROTECTED_TABLE_SUFFIX_GROUPS = Object.freeze({
  woocommerce_orders: Object.freeze([
    'wc_customer_lookup',
    'wc_order_addresses',
    'wc_order_coupon_lookup',
    'wc_order_operational_data',
    'wc_order_product_lookup',
    'wc_order_stats',
    'wc_order_tax_lookup',
    'wc_orders',
    'wc_orders_meta',
    'woocommerce_order_itemmeta',
    'woocommerce_order_items',
    'woocommerce_payment_tokenmeta',
    'woocommerce_payment_tokens',
    'woocommerce_sessions',
  ]),
  users_membership: Object.freeze([
    'usermeta',
    'users',
  ]),
  comments_reviews: Object.freeze([
    'commentmeta',
    'comments',
  ]),
  action_scheduler: Object.freeze([
    'actionscheduler_actions',
    'actionscheduler_claims',
    'actionscheduler_groups',
    'actionscheduler_logs',
  ]),
});

const SUFFIX_TO_CATEGORY = new Map(
  Object.entries(PROTECTED_TABLE_SUFFIX_GROUPS).flatMap(([category, suffixes]) => (
    suffixes.map((suffix) => [suffix, category])
  )),
);

const CATEGORY_REASONS = Object.freeze({
  woocommerce_orders: 'Production WooCommerce order, payment, session and customer commerce data is protected by default',
  users_membership: 'Production user accounts and membership metadata are protected by default',
  comments_reviews: 'Production comments and product reviews are protected by default',
  action_scheduler: 'Production Action Scheduler live job queues are protected by default',
  shared_live_posts: 'Production posts/postmeta contain live order or subscription post types and cannot be blindly overwritten',
});

export class WordPressSelectiveTransferError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WordPressSelectiveTransferError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new WordPressSelectiveTransferError(`wordpress_selective_${code}`, message, status);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTablePrefix(value) {
  if (typeof value !== 'string' || !TABLE_PREFIX_PATTERN.test(value)) {
    fail('prefix_invalid', 'WordPress tablePrefix must match ^[a-zA-Z0-9_]{1,32}$', 400);
  }
  return value;
}

function normalizeTableList(rawTables, tablePrefix, label) {
  if (!Array.isArray(rawTables)) {
    fail('tables_invalid', `${label} must be an array of table names or table descriptors`, 400);
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of rawTables) {
    let name;
    let tableType = 'BASE TABLE';
    if (typeof entry === 'string') {
      name = entry;
    } else if (isPlainObject(entry) && typeof entry.name === 'string') {
      name = entry.name;
      if (entry.type !== undefined && entry.type !== null) {
        if (typeof entry.type !== 'string') {
          fail('tables_invalid', `${label} table descriptor type must be a string`, 400);
        }
        tableType = entry.type.trim().toUpperCase();
      }
    } else {
      fail('tables_invalid', `${label} contains an invalid table entry`, 400);
    }

    if (tableType === 'VIEW' || tableType === 'SYSTEM VIEW') {
      fail('view_unsupported', `Database view "${name}" is not allowed in WordPress selective transfers`, 409);
    }
    if (tableType !== 'BASE TABLE' && tableType !== 'TABLE') {
      fail('view_unsupported', `Unsupported database object type "${tableType}" for "${name}"`, 409);
    }
    if (!TABLE_NAME_PATTERN.test(name)) {
      fail('table_name_invalid', `Table name "${name}" contains unsupported characters`, 400);
    }
    if (!name.startsWith(tablePrefix) || name.length === tablePrefix.length) {
      fail('table_prefix_mismatch', `Table "${name}" does not match declared WordPress prefix "${tablePrefix}"`, 409);
    }
    const suffixLower = name.slice(tablePrefix.length).toLowerCase();
    if (MULTISITE_TABLE_SUFFIXES.has(suffixLower) || /^[0-9]+_/.test(suffixLower)) {
      fail('multisite_unsupported', `WordPress multisite table "${name}" is not supported for selective transfer`, 409);
    }
    const canonicalKey = name.toLowerCase();
    if (seen.has(canonicalKey)) {
      fail('duplicate_table', `Duplicate table "${name}" in ${label}`, 400);
    }
    seen.add(canonicalKey);
    normalized.push(name);
  }
  return normalized.sort();
}

function normalizeLivePostTypes(rawPostTypes = []) {
  if (!Array.isArray(rawPostTypes)) {
    fail('post_types_invalid', 'livePostTypes must be an array of WordPress post type identifiers', 400);
  }
  const detected = new Set();
  for (const postType of rawPostTypes) {
    if (typeof postType !== 'string' || !POST_TYPE_PATTERN.test(postType)) {
      fail('post_types_invalid', 'Each WordPress post type must be a bounded alphanumeric identifier', 400);
    }
    const lower = postType.toLowerCase();
    if (LIVE_COMMERCE_POST_TYPE_SET.has(lower)) {
      detected.add(lower);
    }
  }
  return Object.freeze([...detected].sort());
}

export function requiredProtectedTableOverrideConfirmation(tablePrefix, tables) {
  const prefix = normalizeTablePrefix(tablePrefix);
  if (!Array.isArray(tables) || tables.length === 0) {
    fail('override_confirmation_required', 'At least one protected table is required to build a typed override confirmation', 400);
  }
  const uniqueSorted = [...new Set(tables)].sort();
  return `OVERWRITE_PRODUCTION_PROTECTED_TABLES:${prefix}:${uniqueSorted.join(',')}`;
}

export function classifyWordPressTables({
  tablePrefix,
  stagingTables,
  productionTables = [],
  livePostTypes = [],
  options = {},
} = {}) {
  const prefix = normalizeTablePrefix(tablePrefix);
  if (!isPlainObject(options)) {
    fail('options_invalid', 'Table classification options must be an object', 400);
  }
  const staging = normalizeTableList(stagingTables, prefix, 'stagingTables');
  const production = normalizeTableList(productionTables, prefix, 'productionTables');
  const stagingSet = new Set(staging);
  const productionSet = new Set(production);
  const detectedLiveOrderPostTypes = normalizeLivePostTypes(livePostTypes);
  const hasLiveCommercePosts = detectedLiveOrderPostTypes.length > 0;
  const sharedPostSuffixSet = new Set(['posts', 'postmeta']);

  // Build map of every protected table across staging + production (case-insensitive suffix matching).
  const allTables = [...new Set([...staging, ...production])].sort();
  const protectedCategoryByTable = new Map();
  for (const table of allTables) {
    const suffixLower = table.slice(prefix.length).toLowerCase();
    const defaultCategory = SUFFIX_TO_CATEGORY.get(suffixLower);
    if (defaultCategory) {
      protectedCategoryByTable.set(table, defaultCategory);
    } else if (hasLiveCommercePosts && sharedPostSuffixSet.has(suffixLower)) {
      protectedCategoryByTable.set(table, 'shared_live_posts');
    }
  }

  // Validate optional content-only post type filter for shared posts/postmeta.
  let contentOnlyPostTypes = [];
  if (options.contentOnlyPostTypes !== undefined && options.contentOnlyPostTypes !== null) {
    if (!Array.isArray(options.contentOnlyPostTypes)) {
      fail('post_types_invalid', 'options.contentOnlyPostTypes must be an array of post types', 400);
    }
    const seenTypes = new Set();
    for (const postType of options.contentOnlyPostTypes) {
      if (typeof postType !== 'string' || !POST_TYPE_PATTERN.test(postType)) {
        fail('post_types_invalid', 'options.contentOnlyPostTypes contains an invalid post type', 400);
      }
      const lower = postType.toLowerCase();
      if (LIVE_COMMERCE_POST_TYPE_SET.has(lower)) {
        fail(
          'shared_posts_protected',
          `Content-only filter cannot include live commerce post type "${postType}"`,
          409,
        );
      }
      seenTypes.add(lower);
    }
    contentOnlyPostTypes = [...seenTypes].sort();
  }

  // Validate optional explicit protected table overrides (requires exact typed confirmation).
  const overriddenSet = new Set();
  if (options.overrideProtectedTables !== undefined && options.overrideProtectedTables !== null) {
    if (!Array.isArray(options.overrideProtectedTables)) {
      fail('options_invalid', 'options.overrideProtectedTables must be an array of table names', 400);
    }
    if (options.overrideProtectedTables.length > 0) {
      const normalizedOverrides = normalizeTableList(options.overrideProtectedTables, prefix, 'overrideProtectedTables');
      for (const table of normalizedOverrides) {
        if (!stagingSet.has(table) || !protectedCategoryByTable.has(table)) {
          fail(
            'override_invalid',
            `Table "${table}" cannot be overridden because it is not a protected staging table`,
            409,
          );
        }
        overriddenSet.add(table);
      }
      const expectedConfirmation = requiredProtectedTableOverrideConfirmation(prefix, normalizedOverrides);
      if (options.overrideConfirmation !== expectedConfirmation) {
        fail(
          'override_confirmation_required',
          `Overriding protected production tables requires exact typed confirmation: ${expectedConfirmation}`,
          409,
        );
      }
    }
  }

  // Validate optional explicit includeTables selection.
  let requestedTables = null;
  if (options.includeTables !== undefined && options.includeTables !== null) {
    const normalizedRequested = normalizeTableList(options.includeTables, prefix, 'includeTables');
    for (const table of normalizedRequested) {
      if (!stagingSet.has(table)) {
        fail('table_unknown', `Requested table "${table}" does not exist in stagingTables`, 409);
      }
      const protectedCategory = protectedCategoryByTable.get(table);
      if (protectedCategory && !overriddenSet.has(table)) {
        if (protectedCategory === 'shared_live_posts') {
          if (contentOnlyPostTypes.length === 0) {
            fail(
              'shared_posts_protected',
              `Table "${table}" is protected because production contains live commerce post types (${detectedLiveOrderPostTypes.join(', ')}). Provide contentOnlyPostTypes or an explicit typed override`,
              409,
            );
          }
        } else {
          fail(
            'protected_table_blocked',
            `Protected production table "${table}" (${protectedCategory}) cannot be overwritten without explicit typed override`,
            409,
          );
        }
      }
    }
    requestedTables = new Set(normalizedRequested);
  }

  const transferable = [];
  const protectedEntries = [];
  const preservedProductionOnly = production.filter((table) => !stagingSet.has(table));

  for (const table of staging) {
    const category = protectedCategoryByTable.get(table);
    const isOverridden = overriddenSet.has(table);
    const isContentFilteredShared = category === 'shared_live_posts' && contentOnlyPostTypes.length > 0;
    const isRequested = requestedTables === null || requestedTables.has(table);

    if (category && !isOverridden && !isContentFilteredShared) {
      protectedEntries.push(Object.freeze({
        table,
        category,
        reason: CATEGORY_REASONS[category],
        presentInStaging: true,
        presentInProduction: productionSet.has(table),
      }));
      continue;
    }

    if (isRequested) {
      transferable.push(table);
    } else if (category) {
      protectedEntries.push(Object.freeze({
        table,
        category,
        reason: CATEGORY_REASONS[category],
        presentInStaging: true,
        presentInProduction: productionSet.has(table),
      }));
    }
  }

  // Production-only protected tables must stay explicitly recorded and never silently dropped.
  for (const table of preservedProductionOnly) {
    const category = protectedCategoryByTable.get(table);
    if (category) {
      protectedEntries.push(Object.freeze({
        table,
        category,
        reason: CATEGORY_REASONS[category],
        presentInStaging: false,
        presentInProduction: true,
      }));
    }
  }

  protectedEntries.sort((left, right) => left.table.localeCompare(right.table));
  transferable.sort();

  const sharedProtectedTables = allTables.filter(
    (table) => hasLiveCommercePosts && sharedPostSuffixSet.has(table.slice(prefix.length).toLowerCase()),
  );
  const sharedMode = !hasLiveCommercePosts
    ? 'inactive'
    : sharedProtectedTables.some((table) => overriddenSet.has(table))
      ? 'explicit_override'
      : (contentOnlyPostTypes.length > 0 && sharedProtectedTables.some((table) => transferable.includes(table)))
        ? 'content_only_filtered'
        : 'protected';

  return Object.freeze({
    tablePrefix: prefix,
    transferable: Object.freeze(transferable),
    protected: Object.freeze(protectedEntries),
    overriddenProtected: Object.freeze([...overriddenSet].sort()),
    preservedProductionOnly: Object.freeze(preservedProductionOnly),
    sharedPostsGuard: Object.freeze({
      active: hasLiveCommercePosts,
      livePostTypes: detectedLiveOrderPostTypes,
      protectedTables: Object.freeze(sharedProtectedTables),
      mode: sharedMode,
      contentOnlyPostTypes: Object.freeze(contentOnlyPostTypes),
    }),
  });
}

function assertSafeRelativePosixPath(value, code = 'unsafe_path') {
  if (typeof value !== 'string' || !value || value.length > 512) {
    fail(code, 'File path must be a bounded non-empty relative path', 400);
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail(code, `Unsafe file path rejected: "${value}"`, 400);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(code, `Path traversal or empty segment rejected: "${value}"`, 400);
  }
  return value;
}

function isAlwaysProtectedFilePath(relativePath) {
  const segments = relativePath.split('/');
  const base = segments[segments.length - 1].toLowerCase();
  return ALWAYS_PROTECTED_FILENAME_SET.has(base);
}

export function isSensitiveSecretFilePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return false;
  return relativePath.toLowerCase().split('/').some((name) => (
    name === '.env' || name.startsWith('.env.') || name.endsWith('.pem') || name.endsWith('.key')
    || name === 'id_rsa' || name === 'id_ed25519'
  ));
}

function isUploadsPath(relativePath) {
  const lower = relativePath.toLowerCase();
  return lower === UPLOADS_PREFIX || lower.startsWith(`${UPLOADS_PREFIX}/`);
}

function normalizeScopeOptions(rawScopes) {
  let scopes;
  let customPaths = [];
  let includeUploads = false;

  if (Array.isArray(rawScopes)) {
    scopes = rawScopes;
  } else if (isPlainObject(rawScopes)) {
    scopes = rawScopes.scopes ?? [];
    customPaths = rawScopes.customPaths ?? [];
    includeUploads = rawScopes.includeUploads ?? false;
  } else {
    fail('file_scope_invalid', 'File scopes must be an array of scope names or a scope options object', 400);
  }

  if (!Array.isArray(scopes) || typeof includeUploads !== 'boolean' || !Array.isArray(customPaths)) {
    fail('file_scope_invalid', 'Invalid selective file scope options', 400);
  }
  const normalizedScopes = [];
  const seenScopes = new Set();
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !ALLOWED_FILE_SCOPE_SET.has(scope)) {
      fail('file_scope_invalid', `Unsupported file scope "${String(scope)}"; use themes, plugins, mu-plugins or custom`, 400);
    }
    if (!seenScopes.has(scope)) {
      seenScopes.add(scope);
      normalizedScopes.push(scope);
    }
  }
  if (normalizedScopes.length === 0 && !includeUploads) {
    fail('file_scope_invalid', 'Select at least one file scope or explicitly enable includeUploads', 400);
  }

  const normalizedCustomPaths = [];
  if (seenScopes.has('custom')) {
    if (customPaths.length === 0) {
      fail('custom_path_invalid', 'The custom scope requires at least one relative path under wp-content/', 400);
    }
    const seenCustom = new Set();
    for (const rawPath of customPaths) {
      const cleaned = assertSafeRelativePosixPath(
        typeof rawPath === 'string' && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath,
        'custom_path_invalid',
      );
      if (!cleaned.startsWith('wp-content/') || cleaned === 'wp-content') {
        fail('custom_path_invalid', `Custom scope path "${cleaned}" must reside strictly inside wp-content/`, 400);
      }
      if (isAlwaysProtectedFilePath(cleaned)) {
        fail('protected_path_blocked', `Protected configuration path "${cleaned}" cannot be included in custom scope`, 409);
      }
      if (isSensitiveSecretFilePath(cleaned)) {
        fail('protected_path_blocked', `Sensitive secret path "${cleaned}" cannot be included in custom scope`, 409);
      }
      if (isUploadsPath(cleaned) && !includeUploads) {
        fail('protected_path_blocked', 'wp-content/uploads is protected by default; set includeUploads: true to transfer uploads', 409);
      }
      if (!seenCustom.has(cleaned)) {
        seenCustom.add(cleaned);
        normalizedCustomPaths.push(cleaned);
      }
    }
  } else if (customPaths.length > 0) {
    fail('custom_path_invalid', 'customPaths requires "custom" to be enabled in scopes', 400);
  }

  return Object.freeze({
    scopes: Object.freeze(normalizedScopes.sort()),
    customPaths: Object.freeze(normalizedCustomPaths.sort()),
    includeUploads,
  });
}

function matchSelectiveScope(relativePath, scopeConfig) {
  const scopePrefixes = [];
  if (scopeConfig.scopes.includes('themes')) scopePrefixes.push(['themes', 'wp-content/themes']);
  if (scopeConfig.scopes.includes('plugins')) scopePrefixes.push(['plugins', 'wp-content/plugins']);
  if (scopeConfig.scopes.includes('mu-plugins')) scopePrefixes.push(['mu-plugins', 'wp-content/mu-plugins']);
  for (const customPath of scopeConfig.customPaths) {
    scopePrefixes.push(['custom', customPath]);
  }
  for (const [scopeName, prefix] of scopePrefixes) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) {
      return scopeName;
    }
  }
  return null;
}

export function filterSelectiveFileEntries(entries, scopeOptions = ['themes', 'plugins']) {
  if (!Array.isArray(entries)) {
    fail('files_invalid', 'File entries must be an array', 400);
  }
  const scopeConfig = normalizeScopeOptions(scopeOptions);
  if (entries.length > (scopeConfig.includeUploads ? MAX_ENTRIES : MAX_ENTRIES + 64)) {
    fail('files_limit', `File entry count exceeds limit of ${MAX_ENTRIES}`, 413);
  }
  const seenPaths = new Set();
  const transferable = [];
  const protectedEntries = [];
  const excluded = [];
  let countedEntries = 0;

  for (const rawEntry of entries) {
    let entryPath;
    let type = 'file';
    let bytes = null;
    let sha256Digest = null;

    if (typeof rawEntry === 'string') {
      entryPath = assertSafeRelativePosixPath(rawEntry);
    } else if (isPlainObject(rawEntry)) {
      if (rawEntry.isSymbolicLink === true || rawEntry.type === 'symlink') {
        fail('symlink_rejected', `Symbolic link "${String(rawEntry.path ?? '')}" is rejected fail-closed`, 409);
      }
      entryPath = assertSafeRelativePosixPath(rawEntry.path);
      if (rawEntry.type !== undefined) {
        if (!['file', 'directory'].includes(rawEntry.type)) {
          fail('unsafe_entry', `Unsupported file entry type "${String(rawEntry.type)}" at "${entryPath}"`, 400);
        }
        type = rawEntry.type;
      }
      if (rawEntry.bytes !== undefined && rawEntry.bytes !== null) {
        if (!Number.isSafeInteger(rawEntry.bytes) || rawEntry.bytes < 0 || rawEntry.bytes > MAX_FILE_BYTES) {
          fail('files_limit', `File byte size out of bounds for "${entryPath}"`, 413);
        }
        bytes = rawEntry.bytes;
      }
      if (rawEntry.sha256 !== undefined && rawEntry.sha256 !== null) {
        if (typeof rawEntry.sha256 !== 'string' || !SHA256_PATTERN.test(rawEntry.sha256)) {
          fail('files_invalid', `Invalid SHA-256 digest for "${entryPath}"`, 400);
        }
        sha256Digest = rawEntry.sha256;
      }
    } else {
      fail('files_invalid', 'Each file entry must be a relative path string or descriptor object', 400);
    }

    if (seenPaths.has(entryPath)) {
      fail('duplicate_path', `Duplicate file entry "${entryPath}"`, 400);
    }
    seenPaths.add(entryPath);

    const normalizedEntry = Object.freeze({
      path: entryPath,
      type,
      ...(bytes !== null ? { bytes } : {}),
      ...(sha256Digest !== null ? { sha256: sha256Digest } : {}),
    });

    if (isAlwaysProtectedFilePath(entryPath)) {
      protectedEntries.push(Object.freeze({
        ...normalizedEntry,
        reason: 'production_runtime_config',
      }));
      continue;
    }

    if (isSensitiveSecretFilePath(entryPath)) {
      protectedEntries.push(Object.freeze({
        path: entryPath,
        type,
        ...(bytes !== null ? { bytes } : {}),
        reason: 'sensitive_secret_file',
      }));
      continue;
    }

    if (isUploadsPath(entryPath)) {
      if (scopeConfig.includeUploads) {
        countedEntries += 1;
        if (countedEntries > MAX_ENTRIES) {
          fail('files_limit', `File entry count exceeds limit of ${MAX_ENTRIES}`, 413);
        }
        transferable.push(Object.freeze({ ...normalizedEntry, scope: 'uploads' }));
      } else {
        protectedEntries.push(Object.freeze({
          ...normalizedEntry,
          reason: 'production_uploads_protected',
        }));
      }
      continue;
    }

    countedEntries += 1;
    if (countedEntries > MAX_ENTRIES) {
      fail('files_limit', `File entry count exceeds limit of ${MAX_ENTRIES}`, 413);
    }

    const matchedScope = matchSelectiveScope(entryPath, scopeConfig);
    if (matchedScope) {
      transferable.push(Object.freeze({ ...normalizedEntry, scope: matchedScope }));
    } else {
      excluded.push(normalizedEntry);
    }
  }

  const byPath = (left, right) => left.path.localeCompare(right.path);
  transferable.sort(byPath);
  protectedEntries.sort(byPath);
  excluded.sort(byPath);

  return Object.freeze({
    scopes: scopeConfig.scopes,
    customPaths: scopeConfig.customPaths,
    includeUploads: scopeConfig.includeUploads,
    transferable: Object.freeze(transferable),
    protected: Object.freeze(protectedEntries),
    excluded: Object.freeze(excluded),
  });
}

async function readFileSha256NoFollow(filePath, expectedSize) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('unsafe_entry', `Expected regular file at "${filePath}"`, 409);
    }
    if (stat.size > MAX_FILE_BYTES) {
      fail('files_limit', `File "${filePath}" exceeds maximum allowed file size`, 413);
    }
    const digest = createHash('sha256');
    let readBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      readBytes += chunk.length;
      if (readBytes > MAX_FILE_BYTES) {
        fail('files_limit', `File "${filePath}" grew beyond maximum allowed file size`, 413);
      }
      digest.update(chunk);
    }
    if (readBytes !== expectedSize || readBytes !== stat.size) {
      fail('file_changed', `File "${filePath}" changed during selective transfer scan`, 409);
    }
    return { bytes: readBytes, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function scanSelectiveWordPressFiles(rootDir, scopeOptions = ['themes', 'plugins']) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir) || /[\u0000-\u001f\u007f]/.test(rootDir)
    || rootDir.split(path.sep).some((segment) => segment === '.' || segment === '..')) {
    fail('root_invalid', 'Provide a canonical absolute WordPress root directory', 400);
  }
  const scopeConfig = normalizeScopeOptions(scopeOptions);
  const resolvedRoot = path.resolve(rootDir);
  let rootStat;
  try {
    rootStat = await lstat(resolvedRoot);
  } catch {
    fail('root_unavailable', 'WordPress root directory does not exist or cannot be inspected', 404);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || await realpath(resolvedRoot) !== resolvedRoot) {
    fail('symlink_rejected', 'WordPress root directory must be a real local directory without symlink components', 409);
  }

  const entries = [];
  let countedEntries = 0;
  let totalBytes = 0;

  async function walk(directory, relativePrefix) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const relative = relativePrefix ? `${relativePrefix}/${name}` : name;
      assertSafeRelativePosixPath(relative);
      const childPath = path.join(directory, name);
      const childStat = await lstat(childPath);

      if (childStat.isSymbolicLink()) {
        fail('symlink_rejected', `Symbolic link "${relative}" is not allowed inside a WordPress transfer root`, 409);
      }
      if (childStat.isDirectory()) {
        const realChild = await realpath(childPath);
        const relFromRoot = path.relative(resolvedRoot, realChild);
        if (!relFromRoot || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
          fail('symlink_rejected', `Directory "${relative}" escapes the WordPress root`, 409);
        }
        const protectedTree = isSensitiveSecretFilePath(relative) || (isUploadsPath(relative) && !scopeConfig.includeUploads);
        if (!protectedTree) {
          if (countedEntries >= MAX_ENTRIES) {
            fail('files_limit', `Scanned WordPress tree exceeds limit of ${MAX_ENTRIES} entries`, 413);
          }
          countedEntries += 1;
        }
        entries.push({ path: relative, type: 'directory' });
        if (!protectedTree) {
          await walk(childPath, relative);
        }
        continue;
      }
      if (!childStat.isFile()) {
        fail('unsafe_entry', `Special filesystem entry "${relative}" is not allowed`, 409);
      }

      const skipUploadsFile = isUploadsPath(relative) && !scopeConfig.includeUploads;
      if (!skipUploadsFile) {
        if (countedEntries >= MAX_ENTRIES) {
          fail('files_limit', `Scanned WordPress tree exceeds limit of ${MAX_ENTRIES} entries`, 413);
        }
        countedEntries += 1;
      }

      const willTransfer = !isAlwaysProtectedFilePath(relative)
        && !isSensitiveSecretFilePath(relative)
        && ((isUploadsPath(relative) && scopeConfig.includeUploads)
          || (!isUploadsPath(relative) && matchSelectiveScope(relative, scopeConfig) !== null));

      if (willTransfer) {
        const hashed = await readFileSha256NoFollow(childPath, childStat.size);
        totalBytes += hashed.bytes;
        if (totalBytes > MAX_TOTAL_BYTES) {
          fail('files_limit', 'Selected WordPress files exceed the total transfer size budget', 413);
        }
        entries.push({ path: relative, type: 'file', bytes: hashed.bytes, sha256: hashed.sha256 });
      } else {
        // Protected or out-of-scope files (e.g. wp-config.php) are never read into memory.
        entries.push({ path: relative, type: 'file', bytes: Math.min(childStat.size, MAX_FILE_BYTES) });
      }
    }
  }

  await walk(resolvedRoot, '');
  const filtered = filterSelectiveFileEntries(entries, scopeConfig);
  return Object.freeze({
    rootDir: resolvedRoot,
    totalTransferBytes: totalBytes,
    ...filtered,
  });
}

function normalizeSiteDescriptor(site, label) {
  if (!isPlainObject(site)) {
    fail('site_invalid', `${label} must be an object with websiteId, domain, url and tablePrefix`, 400);
  }
  let websiteId;
  try {
    websiteId = assertUuid(site.websiteId, `${label}.websiteId`);
  } catch {
    fail('site_invalid', `${label}.websiteId must be a valid UUID`, 400);
  }
  let domain;
  try {
    domain = normalizeDomainSet(site.domain, []).primary;
  } catch (error) {
    if (error instanceof DomainValidationError) {
      fail('site_invalid', `${label}.domain is invalid: ${error.message}`, 400);
    }
    throw error;
  }
  if (isIP(domain)) {
    fail('site_invalid', `${label}.domain must be a DNS domain name, not an IP address`, 400);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(String(site.url ?? ''));
  } catch {
    fail('site_invalid', `${label}.url must be a valid root http/https URL`, 400);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)
    || parsedUrl.hostname.toLowerCase() !== domain
    || parsedUrl.username || parsedUrl.password || parsedUrl.port
    || parsedUrl.search || parsedUrl.hash || !['', '/'].includes(parsedUrl.pathname)) {
    fail('site_invalid', `${label}.url must be a clean root http/https URL matching ${domain}`, 400);
  }
  const tablePrefix = normalizeTablePrefix(site.tablePrefix);
  return Object.freeze({
    websiteId,
    domain,
    url: `${parsedUrl.protocol}//${domain}`,
    tablePrefix,
  });
}

function normalizeBackupReference(backup) {
  if (backup === undefined || backup === null) return null;
  if (!isPlainObject(backup)
    || typeof backup.backupId !== 'string' || !BACKUP_ID_PATTERN.test(backup.backupId)
    || typeof backup.sha256 !== 'string' || !SHA256_PATTERN.test(backup.sha256)) {
    fail('backup_invalid', 'preTransferBackup requires a valid backupId and lowercase SHA-256 digest', 400);
  }
  return Object.freeze({
    backupId: backup.backupId,
    sha256: backup.sha256,
  });
}

function normalizeHealthPath(value = '/') {
  if (typeof value !== 'string' || !HEALTH_PATH_PATTERN.test(value) || value.includes('..') || value.includes('//')) {
    fail('health_path_invalid', 'healthCheckPath must be a safe URI path starting with /', 400);
  }
  return value;
}

export function planWordPressSelectiveTransfer({
  stagingSite,
  productionSite,
  stagingTables = [],
  productionTables = [],
  livePostTypes = [],
  tableOptions = {},
  fileEntries = [],
  fileScopes = ['themes', 'plugins'],
  preTransferBackup = null,
  healthCheckPath = '/',
} = {}) {
  const staging = normalizeSiteDescriptor(stagingSite, 'stagingSite');
  const production = normalizeSiteDescriptor(productionSite, 'productionSite');

  if (staging.websiteId === production.websiteId || staging.domain === production.domain || staging.url === production.url) {
    fail('target_invalid', 'Staging and production sites must be distinct websites and domains', 409);
  }
  const hasDatabaseScope = (Array.isArray(stagingTables) && stagingTables.length > 0)
    || (Array.isArray(productionTables) && productionTables.length > 0)
    || (Array.isArray(livePostTypes) && livePostTypes.length > 0)
    || (isPlainObject(tableOptions) && Object.keys(tableOptions).length > 0);
  if (hasDatabaseScope && staging.tablePrefix !== production.tablePrefix) {
    fail(
      'prefix_mismatch',
      `Cross-prefix selective transfer is blocked (${staging.tablePrefix} !== ${production.tablePrefix})`,
      409,
    );
  }

  const tables = classifyWordPressTables({
    tablePrefix: staging.tablePrefix,
    stagingTables,
    productionTables,
    livePostTypes,
    options: tableOptions,
  });
  const files = filterSelectiveFileEntries(fileEntries, fileScopes);

  if (tables.transferable.length === 0 && files.transferable.length === 0) {
    fail('empty_plan', 'Selective transfer plan must include at least one transferable file or table', 409);
  }

  const backup = normalizeBackupReference(preTransferBackup);
  const normalizedHealthPath = normalizeHealthPath(healthCheckPath);
  const restoresDatabase = tables.transferable.length > 0;

  const postTransferRestoration = Object.freeze({
    urlSearchReplace: Object.freeze({
      from: staging.url,
      to: production.url,
      tables: tables.transferable,
      skipColumns: Object.freeze(['guid']),
    }),
    options: Object.freeze(restoresDatabase ? {
      siteurl: production.url,
      home: production.url,
      blog_public: '1',
    } : {}),
    wpConfig: Object.freeze({
      set: Object.freeze(restoresDatabase ? {
        WP_ENVIRONMENT_TYPE: 'production',
      } : {}),
      delete: Object.freeze(restoresDatabase ? ['DISABLE_WP_CRON'] : []),
    }),
  });

  const rollback = Object.freeze({
    preTransferBackupRequired: true,
    backupVerified: Boolean(backup),
    backup,
    preserveProtectedTablesOnRollback: true,
    restoreScope: Object.freeze({
      files: Object.freeze(files.transferable.map((entry) => entry.path)),
      tables: tables.transferable,
    }),
  });

  const verification = Object.freeze({
    wpCoreInstalledCheck: true,
    wpDbCheck: true,
    verifySiteUrlAndHome: true,
    verifyProductionFlags: Object.freeze({
      blog_public: '1',
      WP_ENVIRONMENT_TYPE: 'production',
      DISABLE_WP_CRON: 'absent',
    }),
    httpHealthCheck: Object.freeze({
      required: true,
      domain: production.domain,
      path: normalizedHealthPath,
      expectedStatus: 200,
    }),
  });

  const payload = {
    version: 1,
    readOnly: true,
    stagingSite: staging,
    productionSite: production,
    tables,
    files,
    postTransferRestoration,
    rollback,
    verification,
  };

  return Object.freeze({
    ...payload,
    planSha256: sha256(JSON.stringify(payload)),
  });
}

export function assertSelectiveTransferPlanMatches(approvedPlan, currentPlan) {
  if (!isPlainObject(approvedPlan) || !isPlainObject(currentPlan)
    || typeof approvedPlan.planSha256 !== 'string' || !SHA256_PATTERN.test(approvedPlan.planSha256)
    || typeof currentPlan.planSha256 !== 'string' || !SHA256_PATTERN.test(currentPlan.planSha256)) {
    fail('plan_invalid', 'Both approved and current selective transfer plans must contain valid planSha256 digests', 400);
  }
  if (approvedPlan.planSha256 !== currentPlan.planSha256) {
    fail('plan_drift', 'Selected files, protected tables or transfer parameters changed after preview; re-plan before apply', 409);
  }
  return true;
}

export function assertReadyForSelectiveTransferApply(plan) {
  if (!isPlainObject(plan) || typeof plan.planSha256 !== 'string' || !SHA256_PATTERN.test(plan.planSha256)) {
    fail('plan_invalid', 'A verified selective transfer plan is required before apply', 400);
  }
  if (plan.rollback?.backupVerified !== true || !plan.rollback?.backup) {
    fail('backup_required', 'A verified pre-transfer production backup is required before applying a selective transfer', 409);
  }
  normalizeBackupReference(plan.rollback.backup);
  return true;
}

export const wordpressSelectiveTransferPolicy = Object.freeze({
  allowedFileScopes: ALLOWED_FILE_SCOPES,
  alwaysProtectedFilenames: ALWAYS_PROTECTED_FILENAMES,
  uploadsPrefix: UPLOADS_PREFIX,
  liveCommercePostTypes: LIVE_COMMERCE_POST_TYPES,
  protectedTableSuffixGroups: PROTECTED_TABLE_SUFFIX_GROUPS,
  maxEntries: MAX_ENTRIES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
});
