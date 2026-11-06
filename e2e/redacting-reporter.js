import fs from 'fs';
import path from 'path';

// Failure files (error-context.md and other text attachments) record the page's accessibility
// snapshot, which includes the value typed into the password field. Agents read these files and
// copy them into reports, so the owner password is replaced before anyone can open them (T827).
const REDACTED = '[REDACTED]';
const TEXT_FILE = /\.(md|txt|json|log|html|yml|yaml)$/i;

function ownerSecrets() {
  const values = [process.env.PANEL_OWNER_PASSWORD];
  const file = path.resolve(process.cwd(), '.local/yunpanel-owner-password-only.json');
  try {
    if (fs.existsSync(file)) values.push(JSON.parse(fs.readFileSync(file, 'utf8')).password);
  } catch (error) {
    console.warn(`redacting-reporter: owner password file unreadable: ${error.message}`);
  }
  const forms = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 4) continue;
    forms.add(value);
    forms.add(JSON.stringify(value).slice(1, -1));
    forms.add(encodeURIComponent(value));
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function textFiles(target) {
  let stat;
  try { stat = fs.statSync(target); } catch { return []; }
  if (stat.isFile()) return TEXT_FILE.test(target) ? [target] : [];
  return fs.readdirSync(target).flatMap((name) => textFiles(path.join(target, name)));
}

export function redactFile(file, secrets) {
  const original = fs.readFileSync(file, 'utf8');
  const redacted = secrets.reduce((text, secret) => text.split(secret).join(REDACTED), original);
  if (redacted !== original) fs.writeFileSync(file, redacted);
  return redacted !== original;
}

export default class RedactingReporter {
  onBegin(config) {
    this.secrets = ownerSecrets();
    this.outputDirs = [...new Set(config.projects.map((project) => project.outputDir))];
  }

  onTestEnd(_test, result) {
    for (const attachment of result.attachments) {
      if (attachment.path) this.redact(textFiles(attachment.path));
    }
  }

  onEnd() {
    for (const dir of this.outputDirs) this.redact(textFiles(dir));
  }

  redact(files) {
    if (!this.secrets.length) return;
    for (const file of files) {
      try { redactFile(file, this.secrets); }
      catch (error) { console.warn(`redacting-reporter: could not redact ${file}: ${error.message}`); }
    }
  }

  printsToStdio() {
    return false;
  }
}
