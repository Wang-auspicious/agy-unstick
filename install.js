#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_NAME = 'agy-unstick';
const COPY_ITEMS = [
  'plugin.json',
  'package.json',
  'hooks.json',
  'LICENSE',
  'README.md',
  'assets',
  'rules',
  'scripts',
  'skills',
  'tools',
];
const REQUIRED_RELATIVE_FILES = [
  'plugin.json',
  'hooks.json',
  path.join('scripts', 'cmd-guard-hook.js'),
  path.join('tools', 'safe-launch', 'cli.js'),
  path.join('tools', 'safe-run', 'cli.js'),
  path.join('tools', 'task-doctor', 'cli.js'),
  path.join('rules', 'AGENTS.md'),
];

function getDefaultPluginRoot(targetOverride) {
  if (targetOverride) return path.resolve(targetOverride);
  return path.join(os.homedir(), '.gemini', 'config', 'plugins', PLUGIN_NAME);
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function installPlugin({ sourceDir, targetDir, mode = 'copy' }) {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  if (mode === 'link') {
    fs.symlinkSync(sourceDir, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const item of COPY_ITEMS) {
      const src = path.join(sourceDir, item);
      if (fs.existsSync(src)) {
        copyRecursive(src, path.join(targetDir, item));
      }
    }
  }

  const missing = REQUIRED_RELATIVE_FILES.filter((rel) => !fs.existsSync(path.join(targetDir, rel)));
  if (missing.length > 0) {
    throw new Error(`Installation verification failed, missing: ${missing.join(', ')}`);
  }
  return { ok: true, mode, targetDir };
}

function uninstallPlugin(targetDir) {
  if (!fs.existsSync(targetDir)) {
    return { ok: true, existed: false, targetDir };
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  return { ok: true, existed: true, targetDir };
}

function checkStatus(targetDir) {
  const exists = fs.existsSync(targetDir);
  const missing = exists
    ? REQUIRED_RELATIVE_FILES.filter((rel) => !fs.existsSync(path.join(targetDir, rel)))
    : REQUIRED_RELATIVE_FILES.slice();
  return {
    installed: exists && missing.length === 0,
    targetDir,
    missing,
  };
}

function parseCliArgs(argv) {
  let mode = 'copy';
  let action = 'install';
  let target;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--copy') mode = 'copy';
    else if (tok === '--link') mode = 'link';
    else if (tok === '--uninstall') action = 'uninstall';
    else if (tok === '--status') action = 'status';
    else if (tok === '--target' && argv[i + 1]) target = argv[++i];
    else if (tok === '--help' || tok === '-h') action = 'help';
  }
  return { mode, action, target };
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.action === 'help') {
    process.stdout.write(
      [
        'Usage: node install.js [--copy | --link | --uninstall | --status] [--target <dir>]',
      ].join('\n') + '\n',
    );
    return;
  }

  const targetDir = getDefaultPluginRoot(opts.target);
  if (opts.action === 'status') {
    const st = checkStatus(targetDir);
    process.stdout.write(JSON.stringify(st, null, 2) + '\n');
    process.exit(st.installed ? 0 : 1);
  }
  if (opts.action === 'uninstall') {
    const res = uninstallPlugin(targetDir);
    process.stdout.write(`Removed ${res.targetDir} (existed=${res.existed})\n`);
    return;
  }

  const res = installPlugin({ sourceDir: __dirname, targetDir, mode: opts.mode });
  process.stdout.write(
    [
      `Installed ${PLUGIN_NAME} (${res.mode}) -> ${res.targetDir}`,
      `Manage inside Antigravity UI: [${PLUGIN_NAME}](customization://${PLUGIN_NAME})`,
      `Try forensics scan: node "${path.join(res.targetDir, 'tools', 'task-doctor', 'cli.js')}" scan --days 7`,
    ].join('\n') + '\n',
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  installPlugin,
  uninstallPlugin,
  checkStatus,
  getDefaultPluginRoot,
};
