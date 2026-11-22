import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  WordPressSelectiveTransferError,
  assertReadyForSelectiveTransferApply,
  assertSelectiveTransferPlanMatches,
  classifyWordPressTables,
  filterSelectiveFileEntries,
  planWordPressSelectiveTransfer,
  requiredProtectedTableOverrideConfirmation,
  scanSelectiveWordPressFiles,
  wordpressSelectiveTransferPolicy,
} from '../src/wordpress-selective-transfer.js';

const STAGING_SITE = Object.freeze({
  websiteId: '11111111-1111-4111-8111-111111111111',
  domain: 'staging.shop.example.net',
  url: 'https://staging.shop.example.net',
  tablePrefix: 'wp_',
});

const PRODUCTION_SITE = Object.freeze({
  websiteId: '22222222-2222-4222-8222-222222222222',
  domain: 'shop.example.net',
  url: 'https://shop.example.net',
  tablePrefix: 'wp_',
});

async function createRealWordPressFixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'yunpanel-wp-selective-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stagingDir = path.join(root, 'staging-wp');
  await mkdir(path.join(stagingDir, 'wp-content', 'themes', 'storefront-child'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingDir, 'wp-content', 'plugins', 'custom-blocks'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingDir, 'wp-content', 'mu-plugins'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingDir, 'wp-content', 'uploads', '2026', '11'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingDir, 'wp-content', 'languages'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingDir, 'wp-admin'), { recursive: true, mode: 0o700 });

  await writeFile(path.join(stagingDir, 'wp-config.php'), '<?php define("DB_PASSWORD", "staging-db-secret-marker");\n', { mode: 0o600 });
  await writeFile(path.join(stagingDir, '.htaccess'), '# Staging rules\n', { mode: 0o600 });
  await writeFile(path.join(stagingDir, '.user.ini'), 'memory_limit=256M\n', { mode: 0o600 });
  await writeFile(path.join(stagingDir, 'index.php'), '<?php require __DIR__ . "/wp-blog-header.php";\n', { mode: 0o600 });
  await writeFile(path.join(stagingDir, 'wp-admin', 'index.php'), '<?php // wp-admin\n', { mode: 0o600 });

  const themeCss = '/* Theme Name: Storefront Child */\nbody { color: #111; }\n';
  const pluginPhp = '<?php /* Plugin Name: Custom Blocks */\n';
  const muPluginPhp = '<?php /* Must-Use Guard */\n';
  const langPo = 'msgid "Cart"\nmsgstr "Sepet"\n';
  const uploadJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  await writeFile(path.join(stagingDir, 'wp-content', 'themes', 'storefront-child', 'style.css'), themeCss, { mode: 0o600 });
  await writeFile(path.join(stagingDir, 'wp-content', 'plugins', 'custom-blocks', 'plugin.php'), pluginPhp, { mode: 0o600 });
  await writeFile(path.join(stagingDir, 'wp-content', 'mu-plugins', 'guard.php'), muPluginPhp, { mode: 0o600 });
  await writeFile(path.join(stagingDir, 'wp-content', 'languages', 'tr_TR.po'), langPo, { mode: 0o600 });
  await writeFile(path.join(stagingDir, 'wp-content', 'uploads', '2026', '11', 'invoice.jpg'), uploadJpg, { mode: 0o600 });

  const stagingDbPath = path.join(root, 'staging.sqlite');
  const productionDbPath = path.join(root, 'production.sqlite');
  const stagingDb = new DatabaseSync(stagingDbPath);
  const productionDb = new DatabaseSync(productionDbPath);
  t.after(() => {
    stagingDb.close();
    productionDb.close();
  });

  const sharedCoreTables = [
    'wp_options',
    'wp_terms',
    'wp_term_taxonomy',
    'wp_term_relationships',
    'wp_termmeta',
    'wp_posts',
    'wp_postmeta',
    'wp_users',
    'wp_usermeta',
    'wp_comments',
    'wp_commentmeta',
    'wp_wc_orders',
    'wp_wc_orders_meta',
    'wp_wc_order_addresses',
    'wp_wc_order_operational_data',
    'wp_wc_order_product_lookup',
    'wp_wc_order_stats',
    'wp_wc_order_tax_lookup',
    'wp_wc_order_coupon_lookup',
    'wp_wc_customer_lookup',
    'wp_woocommerce_order_items',
    'wp_woocommerce_order_itemmeta',
    'wp_woocommerce_sessions',
    'wp_woocommerce_payment_tokens',
    'wp_woocommerce_payment_tokenmeta',
    'wp_actionscheduler_actions',
    'wp_actionscheduler_claims',
    'wp_actionscheduler_groups',
    'wp_actionscheduler_logs',
  ];

  for (const table of sharedCoreTables) {
    if (table === 'wp_posts') {
      stagingDb.exec('CREATE TABLE wp_posts (ID INTEGER PRIMARY KEY, post_type TEXT NOT NULL, post_title TEXT)');
      productionDb.exec('CREATE TABLE wp_posts (ID INTEGER PRIMARY KEY, post_type TEXT NOT NULL, post_title TEXT)');
    } else {
      stagingDb.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, payload TEXT)`);
      productionDb.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, payload TEXT)`);
    }
  }
  productionDb.exec('CREATE TABLE wp_live_only_audit (id INTEGER PRIMARY KEY, note TEXT)');

  stagingDb.exec("INSERT INTO wp_posts (ID, post_type, post_title) VALUES (1, 'page', 'Yeni Ana Sayfa')");
  productionDb.exec("INSERT INTO wp_posts (ID, post_type, post_title) VALUES (1, 'page', 'Ana Sayfa'), (101, 'shop_order', 'Sipariş #101'), (102, 'shop_subscription', 'Abonelik #102')");

  const readSqliteTables = (db) => db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const readLivePostTypes = (db) => db
    .prepare('SELECT DISTINCT post_type FROM wp_posts ORDER BY post_type')
    .all()
    .map((row) => row.post_type);

  return {
    root,
    stagingDir,
    stagingDb,
    productionDb,
    themeCss,
    readSqliteTables,
    readLivePostTypes,
  };
}

test('protects WooCommerce orders, users, comments, Action Scheduler and live-order posts/postmeta by default using real SQLite tables', async (t) => {
  const fixture = await createRealWordPressFixture(t);
  const stagingTables = fixture.readSqliteTables(fixture.stagingDb);
  const productionTables = fixture.readSqliteTables(fixture.productionDb);
  const livePostTypes = fixture.readLivePostTypes(fixture.productionDb);

  const classified = classifyWordPressTables({
    tablePrefix: 'wp_',
    stagingTables,
    productionTables,
    livePostTypes,
  });

  assert.equal(Object.isFrozen(classified), true);
  assert.deepEqual(classified.transferable, [
    'wp_options',
    'wp_term_relationships',
    'wp_term_taxonomy',
    'wp_termmeta',
    'wp_terms',
  ]);
  assert.deepEqual(classified.preservedProductionOnly, ['wp_live_only_audit']);
  assert.equal(classified.sharedPostsGuard.active, true);
  assert.equal(classified.sharedPostsGuard.mode, 'protected');
  assert.deepEqual(classified.sharedPostsGuard.livePostTypes, ['shop_order', 'shop_subscription']);
  assert.deepEqual(classified.sharedPostsGuard.protectedTables, ['wp_postmeta', 'wp_posts']);

  const protectedNames = new Set(classified.protected.map((entry) => entry.table));
  for (const suffixes of Object.values(wordpressSelectiveTransferPolicy.protectedTableSuffixGroups)) {
    for (const suffix of suffixes) {
      assert.ok(protectedNames.has(`wp_${suffix}`), `Expected wp_${suffix} to be protected by default`);
      assert.equal(classified.transferable.includes(`wp_${suffix}`), false);
    }
  }
  assert.ok(protectedNames.has('wp_posts'));
  assert.ok(protectedNames.has('wp_postmeta'));

  // Blind full-table overwrite of protected or shared live-order tables fails closed.
  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables,
      productionTables,
      livePostTypes,
      options: { includeTables: ['wp_wc_orders'] },
    }),
    (error) => error instanceof WordPressSelectiveTransferError && error.code === 'wordpress_selective_protected_table_blocked',
  );
  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables,
      productionTables,
      livePostTypes,
      options: { includeTables: ['wp_posts'] },
    }),
    { code: 'wordpress_selective_shared_posts_protected' },
  );

  // Explicit content-only post filter allows non-commerce post types while still blocking live commerce types.
  const filteredPosts = classifyWordPressTables({
    tablePrefix: 'wp_',
    stagingTables,
    productionTables,
    livePostTypes,
    options: {
      includeTables: ['wp_options', 'wp_posts', 'wp_postmeta'],
      contentOnlyPostTypes: ['page', 'post'],
    },
  });
  assert.equal(filteredPosts.sharedPostsGuard.mode, 'content_only_filtered');
  assert.deepEqual(filteredPosts.transferable, ['wp_options', 'wp_postmeta', 'wp_posts']);

  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables,
      productionTables,
      livePostTypes,
      options: {
        includeTables: ['wp_posts'],
        contentOnlyPostTypes: ['page', 'shop_order'],
      },
    }),
    { code: 'wordpress_selective_shared_posts_protected' },
  );
});

test('requires exact typed confirmation to override any protected table and rejects views, multisite and foreign prefixes', async (t) => {
  const fixture = await createRealWordPressFixture(t);
  const stagingTables = fixture.readSqliteTables(fixture.stagingDb);
  const productionTables = fixture.readSqliteTables(fixture.productionDb);

  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables,
      productionTables,
      options: { overrideProtectedTables: ['wp_comments'], overrideConfirmation: 'yes' },
    }),
    { code: 'wordpress_selective_override_confirmation_required' },
  );

  const token = requiredProtectedTableOverrideConfirmation('wp_', ['wp_comments']);
  const overridden = classifyWordPressTables({
    tablePrefix: 'wp_',
    stagingTables,
    productionTables,
    options: {
      includeTables: ['wp_options', 'wp_comments'],
      overrideProtectedTables: ['wp_comments'],
      overrideConfirmation: token,
    },
  });
  assert.deepEqual(overridden.overriddenProtected, ['wp_comments']);
  assert.deepEqual(overridden.transferable, ['wp_comments', 'wp_options']);

  // Real SQLite VIEW rejection.
  fixture.stagingDb.exec('CREATE VIEW wp_orders_view AS SELECT id FROM wp_wc_orders');
  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables: fixture.readSqliteTables(fixture.stagingDb),
      productionTables,
    }),
    { code: 'wordpress_selective_view_unsupported' },
  );
  fixture.stagingDb.exec('DROP VIEW wp_orders_view');

  // Multisite table rejection.
  fixture.stagingDb.exec('CREATE TABLE wp_blogs (blog_id INTEGER PRIMARY KEY)');
  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables: fixture.readSqliteTables(fixture.stagingDb),
      productionTables,
    }),
    { code: 'wordpress_selective_multisite_unsupported' },
  );
  fixture.stagingDb.exec('DROP TABLE wp_blogs');

  // Unknown / cross-prefix table rejection.
  fixture.stagingDb.exec('CREATE TABLE other_options (id INTEGER PRIMARY KEY)');
  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables: fixture.readSqliteTables(fixture.stagingDb),
      productionTables,
    }),
    { code: 'wordpress_selective_table_prefix_mismatch' },
  );
});

test('scans real staging WordPress files with SHA-256, protects config/uploads by default and rejects symlink escapes', async (t) => {
  const fixture = await createRealWordPressFixture(t);

  const scanned = await scanSelectiveWordPressFiles(fixture.stagingDir, {
    scopes: ['themes', 'plugins', 'mu-plugins', 'custom'],
    customPaths: ['wp-content/languages'],
  });

  const transferablePaths = scanned.transferable.map((entry) => entry.path);
  assert.ok(transferablePaths.includes('wp-content/themes/storefront-child/style.css'));
  assert.ok(transferablePaths.includes('wp-content/plugins/custom-blocks/plugin.php'));
  assert.ok(transferablePaths.includes('wp-content/mu-plugins/guard.php'));
  assert.ok(transferablePaths.includes('wp-content/languages/tr_TR.po'));

  const cssEntry = scanned.transferable.find((entry) => entry.path === 'wp-content/themes/storefront-child/style.css');
  assert.equal(cssEntry.sha256, createHash('sha256').update(fixture.themeCss).digest('hex'));
  assert.equal(cssEntry.bytes, Buffer.byteLength(fixture.themeCss));

  // Protected configs and uploads are never transferable by default, and wp-config.php secrets are never read.
  const protectedPaths = scanned.protected.map((entry) => entry.path);
  assert.ok(protectedPaths.includes('wp-config.php'));
  assert.ok(protectedPaths.includes('.htaccess'));
  assert.ok(protectedPaths.includes('.user.ini'));
  assert.ok(protectedPaths.includes('wp-content/uploads'));
  assert.equal(scanned.transferable.some((entry) => entry.path.toLowerCase().startsWith('wp-content/uploads')), false);
  assert.equal(scanned.protected.find((entry) => entry.path === 'wp-config.php').sha256, undefined);
  assert.doesNotMatch(JSON.stringify(scanned), /staging-db-secret-marker/);

  // Explicit includeUploads transfers uploads while keeping wp-config.php/.htaccess/.user.ini protected.
  const withUploads = await scanSelectiveWordPressFiles(fixture.stagingDir, {
    scopes: ['themes'],
    includeUploads: true,
  });
  assert.ok(withUploads.transferable.some((entry) => entry.path === 'wp-content/uploads/2026/11/invoice.jpg' && entry.scope === 'uploads'));
  assert.ok(withUploads.protected.some((entry) => entry.path === 'wp-config.php'));

  // Real symlink escape inside staging tree is rejected fail-closed.
  const outsideSecret = path.join(fixture.root, 'outside-secret.txt');
  await writeFile(outsideSecret, 'host-secret-marker', { mode: 0o600 });
  const escapeLink = path.join(fixture.stagingDir, 'wp-content', 'themes', 'storefront-child', 'escape.php');
  await symlink(outsideSecret, escapeLink);
  await assert.rejects(
    scanSelectiveWordPressFiles(fixture.stagingDir, ['themes']),
    (error) => error instanceof WordPressSelectiveTransferError && error.code === 'wordpress_selective_symlink_rejected',
  );
  await rm(escapeLink);

  // Symlinked wp-content/uploads directory itself is still rejected fail-closed even when includeUploads is false.
  const outsideUploads = path.join(fixture.root, 'outside-uploads');
  await mkdir(outsideUploads, { mode: 0o700 });
  const uploadsPath = path.join(fixture.stagingDir, 'wp-content', 'uploads');
  await rm(uploadsPath, { recursive: true, force: true });
  await symlink(outsideUploads, uploadsPath);
  await assert.rejects(
    scanSelectiveWordPressFiles(fixture.stagingDir, ['themes']),
    (error) => error instanceof WordPressSelectiveTransferError && error.code === 'wordpress_selective_symlink_rejected',
  );
  await rm(uploadsPath);
  await mkdir(path.join(uploadsPath, '2026', '11'), { recursive: true, mode: 0o700 });
});

test('prevents case-sensitivity bypasses for protected tables, multisite, live post types, uploads and forged backups', () => {
  // Mixed-case protected tables cannot bypass protection.
  const mixed = classifyWordPressTables({
    tablePrefix: 'wp_',
    stagingTables: ['wp_options', 'wp_WC_Orders', 'wp_Users', 'wp_Posts', 'wp_PostMeta'],
    productionTables: ['wp_options', 'wp_WC_Orders', 'wp_Users', 'wp_Posts', 'wp_PostMeta'],
    livePostTypes: ['SHOP_ORDER'],
  });
  assert.deepEqual(mixed.transferable, ['wp_options']);
  const protectedNames = mixed.protected.map((entry) => entry.table);
  assert.ok(protectedNames.includes('wp_WC_Orders'));
  assert.ok(protectedNames.includes('wp_Users'));
  assert.ok(protectedNames.includes('wp_Posts'));
  assert.ok(protectedNames.includes('wp_PostMeta'));
  assert.deepEqual(mixed.sharedPostsGuard.livePostTypes, ['shop_order']);
  assert.equal(mixed.sharedPostsGuard.mode, 'protected');

  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables: ['wp_options', 'wp_WC_Orders'],
      options: { includeTables: ['wp_WC_Orders'] },
    }),
    { code: 'wordpress_selective_protected_table_blocked' },
  );
  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables: ['wp_options', 'wp_Posts'],
      livePostTypes: ['SHOP_ORDER'],
      options: { includeTables: ['wp_Posts'], contentOnlyPostTypes: ['SHOP_ORDER'] },
    }),
    { code: 'wordpress_selective_shared_posts_protected' },
  );
  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables: ['wp_options', 'wp_Blogs'],
    }),
    { code: 'wordpress_selective_multisite_unsupported' },
  );
  assert.throws(
    () => classifyWordPressTables({
      tablePrefix: 'wp_',
      stagingTables: ['wp_options', 'wp_OPTIONS'],
    }),
    { code: 'wordpress_selective_duplicate_table' },
  );

  // Mixed-case uploads paths stay protected when includeUploads is false.
  const filteredUploads = filterSelectiveFileEntries(
    ['wp-content/UPLOADS/photo.jpg', 'wp-content/themes/child/style.css'],
    ['themes'],
  );
  assert.deepEqual(filteredUploads.transferable.map((entry) => entry.path), ['wp-content/themes/child/style.css']);
  assert.deepEqual(filteredUploads.protected.map((entry) => entry.path), ['wp-content/UPLOADS/photo.jpg']);
  assert.equal(filteredUploads.protected[0].reason, 'production_uploads_protected');
  assert.throws(
    () => filterSelectiveFileEntries([], { scopes: ['custom'], customPaths: ['wp-content/UPLOADS'] }),
    { code: 'wordpress_selective_protected_path_blocked' },
  );

  // Forged backup metadata fails closed in assertReadyForSelectiveTransferApply.
  assert.throws(
    () => assertReadyForSelectiveTransferApply({
      planSha256: 'a'.repeat(64),
      rollback: { backupVerified: true, backup: { backupId: '../bad', sha256: 'not-sha256' } },
    }),
    { code: 'wordpress_selective_backup_invalid' },
  );
});

test('filterSelectiveFileEntries rejects traversal, absolute paths, NUL bytes, symlinks and protected custom paths', () => {
  for (const unsafe of ['../wp-config.php', '/etc/passwd', 'wp-content/themes/\0bad.php', 'wp-content\\themes\\a.php', 'wp-content/./themes/a.css']) {
    assert.throws(
      () => filterSelectiveFileEntries([unsafe], ['themes']),
      { code: 'wordpress_selective_unsafe_path' },
    );
  }
  assert.throws(
    () => filterSelectiveFileEntries([{ path: 'wp-content/themes/link', type: 'symlink' }], ['themes']),
    { code: 'wordpress_selective_symlink_rejected' },
  );
  assert.throws(
    () => filterSelectiveFileEntries([], { scopes: ['custom'], customPaths: ['wp-content/uploads'] }),
    { code: 'wordpress_selective_protected_path_blocked' },
  );
  assert.throws(
    () => filterSelectiveFileEntries([], { scopes: ['custom'], customPaths: ['wp-admin'] }),
    { code: 'wordpress_selective_custom_path_invalid' },
  );
  assert.throws(
    () => filterSelectiveFileEntries([], { scopes: ['custom'], customPaths: ['wp-content/.htaccess'] }),
    { code: 'wordpress_selective_protected_path_blocked' },
  );
});

test('builds deterministic selective transfer plan with staging-flag reversal, backup gate and drift rejection', async (t) => {
  const fixture = await createRealWordPressFixture(t);
  const stagingTables = fixture.readSqliteTables(fixture.stagingDb);
  const productionTables = fixture.readSqliteTables(fixture.productionDb);
  const livePostTypes = fixture.readLivePostTypes(fixture.productionDb);

  const scanned1 = await scanSelectiveWordPressFiles(fixture.stagingDir, ['themes', 'plugins']);
  const fileEntries1 = [...scanned1.transferable, ...scanned1.protected, ...scanned1.excluded];

  const planWithoutBackup = planWordPressSelectiveTransfer({
    stagingSite: STAGING_SITE,
    productionSite: PRODUCTION_SITE,
    stagingTables,
    productionTables,
    livePostTypes,
    fileEntries: fileEntries1,
    fileScopes: ['themes', 'plugins'],
  });

  assert.equal(Object.isFrozen(planWithoutBackup), true);
  assert.equal(planWithoutBackup.readOnly, true);
  assert.match(planWithoutBackup.planSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(planWithoutBackup.postTransferRestoration.options, {
    siteurl: 'https://shop.example.net',
    home: 'https://shop.example.net',
    blog_public: '1',
  });
  assert.deepEqual(planWithoutBackup.postTransferRestoration.wpConfig, {
    set: { WP_ENVIRONMENT_TYPE: 'production' },
    delete: ['DISABLE_WP_CRON'],
  });
  assert.equal(planWithoutBackup.postTransferRestoration.urlSearchReplace.from, 'https://staging.shop.example.net');
  assert.equal(planWithoutBackup.postTransferRestoration.urlSearchReplace.to, 'https://shop.example.net');
  assert.equal(planWithoutBackup.rollback.preTransferBackupRequired, true);
  assert.equal(planWithoutBackup.rollback.backupVerified, false);
  assert.equal(planWithoutBackup.verification.httpHealthCheck.required, true);
  assert.equal(planWithoutBackup.verification.httpHealthCheck.domain, 'shop.example.net');

  // Apply guard blocks until a verified pre-transfer production backup is attached.
  assert.throws(
    () => assertReadyForSelectiveTransferApply(planWithoutBackup),
    { code: 'wordpress_selective_backup_required' },
  );

  const backupRef = {
    backupId: 'prod-backup-2026-11-21T010000Z',
    sha256: 'a'.repeat(64),
  };
  const planA = planWordPressSelectiveTransfer({
    stagingSite: STAGING_SITE,
    productionSite: PRODUCTION_SITE,
    stagingTables,
    productionTables,
    livePostTypes,
    fileEntries: fileEntries1,
    fileScopes: ['themes', 'plugins'],
    preTransferBackup: backupRef,
  });
  const planB = planWordPressSelectiveTransfer({
    stagingSite: STAGING_SITE,
    productionSite: PRODUCTION_SITE,
    stagingTables: [...stagingTables].reverse(),
    productionTables: [...productionTables].reverse(),
    livePostTypes: [...livePostTypes].reverse(),
    fileEntries: [...fileEntries1].reverse(),
    fileScopes: ['plugins', 'themes'],
    preTransferBackup: backupRef,
  });

  assert.equal(planA.planSha256, planB.planSha256);
  assert.equal(assertSelectiveTransferPlanMatches(planA, planB), true);
  assert.equal(assertReadyForSelectiveTransferApply(planA), true);

  // Modifying a selected theme file on disk changes planSha256 and fails closed on drift check.
  await writeFile(
    path.join(fixture.stagingDir, 'wp-content', 'themes', 'storefront-child', 'style.css'),
    `${fixture.themeCss}/* modified after preview */\n`,
    { mode: 0o600 },
  );
  const scanned2 = await scanSelectiveWordPressFiles(fixture.stagingDir, ['themes', 'plugins']);
  const planAfterEdit = planWordPressSelectiveTransfer({
    stagingSite: STAGING_SITE,
    productionSite: PRODUCTION_SITE,
    stagingTables,
    productionTables,
    livePostTypes,
    fileEntries: [...scanned2.transferable, ...scanned2.protected, ...scanned2.excluded],
    fileScopes: ['themes', 'plugins'],
    preTransferBackup: backupRef,
  });

  assert.notEqual(planAfterEdit.planSha256, planA.planSha256);
  assert.throws(
    () => assertSelectiveTransferPlanMatches(planA, planAfterEdit),
    { code: 'wordpress_selective_plan_drift' },
  );

  // Cross-prefix or same-site plans fail closed.
  assert.throws(
    () => planWordPressSelectiveTransfer({
      stagingSite: STAGING_SITE,
      productionSite: { ...PRODUCTION_SITE, tablePrefix: 'prod_' },
      stagingTables,
      productionTables,
      fileEntries: fileEntries1,
      fileScopes: ['themes'],
    }),
    { code: 'wordpress_selective_prefix_mismatch' },
  );
  assert.throws(
    () => planWordPressSelectiveTransfer({
      stagingSite: STAGING_SITE,
      productionSite: STAGING_SITE,
      stagingTables,
      productionTables,
      fileEntries: fileEntries1,
      fileScopes: ['themes'],
    }),
    { code: 'wordpress_selective_target_invalid' },
  );
});

test('allows distinct per-site YunPanel table prefixes for file-only plans while preserving prefix_mismatch rejection for SQL plans', async (t) => {
  const fixture = await createRealWordPressFixture(t);
  const themeRoot = path.join(fixture.stagingDir, 'wp-content/themes/storefront-child');
  await mkdir(path.join(themeRoot, '.env.local'));
  await writeFile(path.join(themeRoot, '.env.local', 'settings.json'), '{}');
  await writeFile(path.join(themeRoot, 'site.key'), 'test-only');
  const scanned = await scanSelectiveWordPressFiles(fixture.stagingDir, ['themes', 'plugins']);
  const fileEntries = [...scanned.transferable, ...scanned.protected, ...scanned.excluded];
  const stagingYunPanel = { ...STAGING_SITE, tablePrefix: 'yp111111111111_' };
  const productionYunPanel = { ...PRODUCTION_SITE, tablePrefix: 'yp222222222222_' };

  const fileOnlyPlan = planWordPressSelectiveTransfer({
    stagingSite: stagingYunPanel,
    productionSite: productionYunPanel,
    stagingTables: [],
    productionTables: [],
    fileEntries,
    fileScopes: ['themes', 'plugins'],
  });
  assert.equal(fileOnlyPlan.stagingSite.tablePrefix, 'yp111111111111_');
  assert.equal(fileOnlyPlan.productionSite.tablePrefix, 'yp222222222222_');
  assert.deepEqual(fileOnlyPlan.tables.transferable, []);
  assert.deepEqual(fileOnlyPlan.postTransferRestoration.options, {});
  assert.deepEqual(fileOnlyPlan.postTransferRestoration.wpConfig, { set: {}, delete: [] });
  assert.equal(scanned.protected.find(({ path: filePath }) => filePath.endsWith('/site.key')).reason, 'sensitive_secret_file');
  assert.ok(scanned.protected.some(({ path: filePath }) => filePath.endsWith('/.env.local')));
  assert.ok(!fileEntries.some(({ path: filePath }) => filePath.endsWith('/.env.local/settings.json')));
  assert.ok(fileOnlyPlan.files.transferable.some((entry) => entry.path === 'wp-content/themes/storefront-child/style.css'));
  assert.match(fileOnlyPlan.planSha256, /^[a-f0-9]{64}$/);

  // Changing target table prefix alters planSha256 cleanly.
  const otherPrefixPlan = planWordPressSelectiveTransfer({
    stagingSite: stagingYunPanel,
    productionSite: { ...PRODUCTION_SITE, tablePrefix: 'yp333333333333_' },
    stagingTables: [],
    productionTables: [],
    fileEntries,
    fileScopes: ['themes', 'plugins'],
  });
  assert.notEqual(fileOnlyPlan.planSha256, otherPrefixPlan.planSha256);

  // Any SQL/database table transfer across distinct prefixes still fails closed with prefix_mismatch (409).
  assert.throws(
    () => planWordPressSelectiveTransfer({
      stagingSite: stagingYunPanel,
      productionSite: productionYunPanel,
      stagingTables: ['yp111111111111_options'],
      productionTables: ['yp222222222222_options'],
      fileEntries,
      fileScopes: ['themes'],
    }),
    (error) => error instanceof WordPressSelectiveTransferError && error.code === 'wordpress_selective_prefix_mismatch' && error.status === 409,
  );
});
