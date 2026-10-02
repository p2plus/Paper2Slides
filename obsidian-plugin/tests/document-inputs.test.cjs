const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class Plugin {
  constructor() {
    this.commands = [];
    this.app = { workspace: { on() {}, getActiveFile() { return null; } } };
  }
  async loadData() { return {}; }
  addRibbonIcon() {}
  addSettingTab() {}
  registerEvent() {}
  addCommand(command) { this.commands.push(command); }
}

const bundle = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), {
  module: bundle,
  exports: bundle.exports,
  require(name) {
    if (name === 'obsidian') return { Plugin, PluginSettingTab: class {}, TFile: class {} };
    return require(name);
  },
  console,
  process,
  setTimeout,
  clearTimeout,
});
const Paper2Slides = bundle.exports.default;

test('shipped bundle starts and registers generation controls', async () => {
  const plugin = new Paper2Slides();
  await plugin.onload();
  assert.ok(plugin.commands.some(command => command.id === 'generate-slides-current-file'));
});

test('Markdown aliases and Word are accepted with the correct content mode', () => {
  const plugin = new Paper2Slides();
  for (const extension of ['md', 'MD', 'markdown', 'txt']) {
    assert.equal(plugin.isSupportedSource({ extension }), true);
    assert.equal(plugin.getContentType({ extension }), 'general');
  }
  for (const extension of ['docx', 'DOCX', 'pdf', 'pptx']) {
    assert.equal(plugin.isSupportedSource({ extension }), true);
    assert.equal(plugin.getContentType({ extension }), 'paper');
  }
  assert.equal(plugin.isSupportedSource({ extension: 'zip' }), false);
});

test('shipped bundle accepts the same extensions as the Python pipeline', () => {
  const formats = fs.readFileSync(path.join(__dirname, '../../paper2slides/file_formats.py'), 'utf8');
  const extensions = [...new Set([...formats.matchAll(/"\.([a-z]+)"/g)].map(match => match[1]))].sort();
  assert.deepEqual(Array.from(Paper2Slides.supportedSourceExtensions).sort(), extensions);
});
