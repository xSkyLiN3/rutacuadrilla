import { readdir, readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowedExtensions = new Set([
  ".conf",
  ".css",
  ".csv",
  ".example",
  ".geojson",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const allowedNames = new Set([
  ".dockerignore",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  "Caddyfile",
  "Dockerfile.api",
  "Dockerfile.web",
  "LICENSE",
]);
const ignoredDirectories = new Set([".git", ".local", "coverage", "dist", "node_modules"]);
const patterns = [
  { label: "private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "GitHub token", expression: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { label: "npm token", expression: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  {
    label: "npm authentication value",
    expression: /(?:^|\n)\s*(?:_authToken|_auth)\s*=\s*(?![$][{])["']?[^\s"']+/i,
  },
  { label: "AWS access key", expression: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "Google API key", expression: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Slack token", expression: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/ },
  { label: "Stripe secret key", expression: /\bsk_(?:live|test)_[0-9A-Za-z]{20,}\b/ },
  { label: "JWT", expression: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  {
    label: "personal Windows user path",
    expression: /\b[A-Z]:\\Users\\(?![<%$])[^\\/\s]+\\/i,
  },
  {
    label: "Chilean personal identifier",
    expression: /\b\d{1,2}[.]\d{3}[.]\d{3}-[\dkK]\b/,
  },
  {
    label: "Chilean mobile phone",
    expression: /(?<!\d)(?:[+]56[ .-]?)?9(?:[ .-]?\d){8}(?!\d)/,
  },
  {
    label: "non-synthetic Chilean coordinate fixture",
    expression: /(?:-33[.]\d+|-70[.]\d+)/,
  },
];

const ipv4Expression = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:[.](?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;

function allowedIpv4(address) {
  if (
    address === "0.0.0.0" ||
    address.startsWith("10.") ||
    address.startsWith("127.") ||
    address.startsWith("192.168.") ||
    address.startsWith("192.0.2.") ||
    address.startsWith("198.51.100.") ||
    address.startsWith("203.0.113.")
  ) {
    return true;
  }
  const [first, second] = address.split(".").map(Number);
  return first === 172 && second >= 16 && second <= 31;
}

async function loadPrivateDenylist() {
  const path = process.env.RUTACUADRILLA_PRIVATE_DENYLIST_FILE?.trim();
  if (!path) return [];
  if (!isAbsolute(path)) throw new Error("RUTACUADRILLA_PRIVATE_DENYLIST_FILE must be absolute");
  const normalizedPath = resolve(path);
  const relativeToWorkspace = relative(root, normalizedPath);
  if (
    relativeToWorkspace === "" ||
    (!relativeToWorkspace.startsWith("..") && !isAbsolute(relativeToWorkspace))
  ) {
    throw new Error("RUTACUADRILLA_PRIVATE_DENYLIST_FILE must be outside the workspace");
  }
  const content = await readFile(normalizedPath, "utf8");
  return content
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 4 && !entry.startsWith("#"));
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (allowedExtensions.has(extname(entry.name)) || allowedNames.has(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const privateDenylist = await loadPrivateDenylist();
const findings = [];
for (const file of await collect(root)) {
  const content = await readFile(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.expression.test(content)) {
      findings.push(`${relative(root, file)}: posible ${pattern.label}`);
    }
  }
  for (const address of content.match(ipv4Expression) ?? []) {
    if (!allowedIpv4(address)) {
      findings.push(`${relative(root, file)}: posible public IPv4 address`);
      break;
    }
  }
  const normalizedContent = content.toLocaleLowerCase("en");
  if (privateDenylist.some((entry) => normalizedContent.includes(entry.toLocaleLowerCase("en")))) {
    findings.push(`${relative(root, file)}: matches private denylist`);
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Secret and public-safety scan: no findings.");
}
