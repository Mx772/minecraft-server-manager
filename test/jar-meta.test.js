'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const identify = require('../src/services/modIdentify');
const { jarBuffer, tempZip } = require('./helpers/zipfix');

const fixtures = {
  fabric: {
    'fabric.mod.json': JSON.stringify({
      id: 'sodium',
      name: 'Sodium',
      version: '0.5',
      depends: { minecraft: '~1.20' },
    }),
  },
  forge: {
    'META-INF/mods.toml': '[[mods]]\nmodId="jei"\ndisplayName="JEI"\nversion="${file.jarVersion}"\n',
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Version: 15.2\r\n',
  },
  neoforge: { 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="create"\ndisplayName="Create"\nversion="6.0"\n' },
  quilt: {
    'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'oz', version: '1', metadata: { name: 'Ok Zoomer' } } }),
  },
  plugin: { 'plugin.yml': 'name: WorldEdit\nversion: 7.3.0\napi-version: 1.20\n' },
  none: { 'readme.txt': 'nothing' },
};

for (const [name, entries] of Object.entries(fixtures)) {
  test(`parseJarMetaFile matches parseJarMeta for ${name}`, async () => {
    const zipPath = await tempZip(`${name}.jar`, entries);
    const fromFile = await identify.parseJarMetaFile(zipPath);
    const fromBuffer = await identify.parseJarMeta(fs.readFileSync(zipPath));
    assert.deepEqual(fromFile, fromBuffer);
    assert.equal(name === 'none', fromFile === null);
  });
}

test('inspectJarFile returns requested extra entries in the same pass', async () => {
  const zipPath = await tempZip('x.jar', { ...fixtures.fabric, 'extra.md': 'hello', 'other.md': 'skip' });
  const { meta, extras } = await identify.inspectJarFile(zipPath, ['extra.md', 'missing.md']);
  assert.equal(meta.modId, 'sodium');
  assert.deepEqual([...extras], [['extra.md', 'hello']]);
});

test('parseJarMetaFile yields null for a file that is not a zip', async () => {
  const zipPath = await tempZip('y.jar', fixtures.none);
  fs.writeFileSync(zipPath, 'not a zip');
  assert.equal(await identify.parseJarMetaFile(zipPath), null);
  assert.ok(await jarBuffer(fixtures.none));
});
