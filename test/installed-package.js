/**
 * @fileoverview End-to-end checks against the locally packed and installed
 * npm artifact in Node and a browser.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';

const PACKAGE_NAME = '@lhncbc/fml-resource-version-converter';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXPECTED_ARTIFACT_IDS = new Set([
  'fml-mappings/R4toR5',
  'fhir-tables/R4',
  'fhir-tables/R5',
]);

/**
 * Run a command and return its standard output.
 *
 * @param {string} command Executable name.
 * @param {string[]} args Command arguments.
 * @param {string} cwd Working directory.
 * @returns {string} Captured standard output.
 */
function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}:\n`
      + `${result.stderr || result.stdout}`,
    );
  }

  return result.stdout;
}

/**
 * Pack the current working tree without publishing it.
 *
 * Lifecycle scripts are disabled because package validation runs separately
 * and the installed-package test must not recurse if prepack later invokes it.
 *
 * @param {string} temporaryRoot Temporary test root.
 * @returns {string} Absolute path to the generated tarball.
 */
function packProject(temporaryRoot) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = runCommand(npmCommand, [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    temporaryRoot,
  ], PROJECT_ROOT);

  let reports;
  try {
    reports = JSON.parse(output);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(reports) || reports.length !== 1 || !reports[0].filename) {
    throw new Error('npm pack must return exactly one tarball filename');
  }

  return path.join(temporaryRoot, reports[0].filename);
}

/**
 * Create a clean consumer and install the local tarball into it.
 *
 * @param {string} temporaryRoot Temporary test root.
 * @param {string} tarballPath Local package tarball.
 * @returns {string} Consumer project root.
 */
function installPackage(temporaryRoot, tarballPath) {
  const consumerRoot = path.join(temporaryRoot, 'consumer');
  const npmCache = path.join(temporaryRoot, 'npm-cache');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.writeFileSync(path.join(consumerRoot, 'package.json'), `${JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2)}\n`);
  runCommand(npmCommand, [
    'install',
    '--no-audit',
    '--no-fund',
    '--cache',
    npmCache,
    tarballPath,
  ], consumerRoot);

  return consumerRoot;
}

/**
 * Verify default and selective imports from the installed package in Node.
 *
 * @param {string} consumerRoot Consumer project root.
 * @returns {void}
 */
function verifyNodeConsumer(consumerRoot) {
  const smokePath = path.join(consumerRoot, 'node-smoke.mjs');
  const source = `
import assert from 'node:assert/strict';
import { singleHopConverter as defaultConverter } from '${PACKAGE_NAME}';
import { converterFactory } from '${PACKAGE_NAME}/converter-factory';
import runtimeData from '${PACKAGE_NAME}/runtime/r4-to-r5';

const resource = {
  resourceType: 'Questionnaire',
  status: 'active',
  item: [{ linkId: 'one', type: 'string' }],
};
const defaultResult = defaultConverter.convert(resource, 'R4', 'R5');
const selectiveConverter = converterFactory.create(runtimeData).singleHopConverter;
const selectiveResult = selectiveConverter.convert(resource, 'R4', 'R5');

assert.deepEqual(selectiveResult.resource, defaultResult.resource);
assert.equal(selectiveResult.resource.resourceType, 'Questionnaire');
assert.equal(selectiveResult.resource.item[0].type, 'string');
assert.equal(selectiveResult.status, 'ok');
`;

  fs.writeFileSync(smokePath, source.trimStart());
  runCommand(process.execPath, [smokePath], consumerRoot);
}

/**
 * Write the browser consumer used by Vite and Chromium.
 *
 * @param {string} consumerRoot Consumer project root.
 * @returns {void}
 */
function writeBrowserConsumer(consumerRoot) {
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Installed package test</title></head>
  <body><pre id="result">pending</pre><script type="module" src="/browser.mjs"></script></body>
</html>
`;
  const source = `
import { converterFactory } from '${PACKAGE_NAME}/converter-factory';
import runtimeData from '${PACKAGE_NAME}/runtime/r4-to-r5';

const output = document.querySelector('#result');

try {
  const resource = {
    resourceType: 'Questionnaire',
    status: 'active',
    item: [{ linkId: 'one', type: 'string' }],
  };
  const converter = converterFactory.create(runtimeData).singleHopConverter;
  const result = converter.convert(resource, 'R4', 'R5');
  const summary = {
    resourceType: result.resource.resourceType,
    itemType: result.resource.item[0].type,
    status: result.status,
  };

  output.textContent = JSON.stringify(summary);
  document.documentElement.dataset.installedPackageTest = 'passed';
} catch (error) {
  output.textContent = error.stack || error.message;
  document.documentElement.dataset.installedPackageTest = 'failed';
  throw error;
}
`;

  fs.writeFileSync(path.join(consumerRoot, 'index.html'), html);
  fs.writeFileSync(path.join(consumerRoot, 'browser.mjs'), source.trimStart());
}

/**
 * Build the installed selective entry with browser-oriented Vite settings.
 *
 * @param {string} consumerRoot Consumer project root.
 * @returns {Promise<string>} Absolute Vite output directory.
 */
async function buildBrowserConsumer(consumerRoot) {
  await build({
    root: consumerRoot,
    configFile: false,
    logLevel: 'error',
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          sourcemapExcludeSources: true,
        },
      },
    },
  });

  return path.join(consumerRoot, 'dist');
}

/**
 * Recursively return files below a directory.
 *
 * @param {string} root Directory to traverse.
 * @returns {string[]} Absolute file paths.
 */
function listFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(root, entry.name);

    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

/**
 * Read a generated artifact payload prefix from its module source.
 *
 * @param {string} artifactPath Installed artifact module path.
 * @returns {string} Payload prefix suitable for exact bundle checks.
 */
function readPayloadPrefix(artifactPath) {
  const source = fs.readFileSync(artifactPath, 'utf8');
  const match = source.match(/"payload":\s*"([A-Za-z0-9+/=]{80})/);

  assert.ok(match, `Generated payload is missing from ${artifactPath}`);

  return match[1];
}

/**
 * Verify selective bundle composition and source-map behavior.
 *
 * @param {string} consumerRoot Consumer project root.
 * @param {string} distRoot Vite output directory.
 * @returns {void}
 */
function verifyBrowserBundle(consumerRoot, distRoot) {
  const files = listFiles(distRoot);
  const bundlePaths = files.filter(file => file.endsWith('.js'));
  const sourceMapPaths = files.filter(file => file.endsWith('.js.map'));

  assert.ok(bundlePaths.length > 0, 'Vite emitted no JavaScript bundle');
  assert.ok(sourceMapPaths.length > 0, 'Vite emitted no JavaScript source map');

  const bundle = bundlePaths.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const sourceMapText = sourceMapPaths.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const sourceMaps = sourceMapPaths.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));

  for (const sourceMap of sourceMaps) {
    assert.equal(
      Object.hasOwn(sourceMap, 'sourcesContent'),
      false,
      'Vite source maps must exclude dependency source content',
    );
  }

  const packageRoot = path.join(
    consumerRoot,
    'node_modules',
    '@lhncbc',
    'fml-resource-version-converter',
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'data/runtime/manifest.json'), 'utf8'),
  );

  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(packageRoot, 'data/runtime', artifact.modulePath);
    const payloadPrefix = readPayloadPrefix(artifactPath);

    assert.equal(
      bundle.includes(payloadPrefix),
      EXPECTED_ARTIFACT_IDS.has(artifact.id),
      `${artifact.id} has the wrong selective-bundle inclusion state`,
    );
    assert.equal(
      sourceMapText.includes(payloadPrefix),
      false,
      `${artifact.id} payload was copied into a source map`,
    );
  }

  const contextSources = sourceMaps
    .flatMap(sourceMap => sourceMap.sources)
    .map(source => source.replaceAll('\\', '/'))
    .filter(source => source.includes('/fhir-context/'));

  assert.ok(
    contextSources.some(source => source.includes('/fhir-context/r4/')),
    'The selective bundle is missing the R4 FHIRPath model',
  );
  assert.equal(
    contextSources.some(source => /\/fhir-context\/(dstu2|stu3|r4b|r5)\//.test(source)),
    false,
    'The selective bundle contains an unrelated FHIRPath model',
  );
  assert.equal(/node:[a-z_]+/.test(bundle), false, 'The browser bundle contains a Node built-in');
}

/**
 * Start a local static server for the generated browser files.
 *
 * @param {string} distRoot Vite output directory.
 * @returns {Promise<{server: import('node:http').Server, url: string}>}
 *   Running server and its base URL.
 */
function startStaticServer(distRoot) {
  const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
  ]);
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    const relativePath = requestUrl.pathname === '/'
      ? 'index.html'
      : decodeURIComponent(requestUrl.pathname.slice(1));
    const filePath = path.resolve(distRoot, relativePath);
    const insideRoot = filePath === distRoot || filePath.startsWith(`${distRoot}${path.sep}`);

    if (!insideRoot || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404);
      response.end('Not found');

      return;
    }

    response.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(filePath)) || 'application/octet-stream',
    });
    response.end(fs.readFileSync(filePath));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Static server did not bind to a TCP port'));

        return;
      }

      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

/**
 * Close an HTTP server.
 *
 * @param {import('node:http').Server} server Server to close.
 * @returns {Promise<void>} Resolves when the server is closed.
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

/**
 * Execute the generated application in Playwright-managed Chromium.
 *
 * @param {string} distRoot Vite output directory.
 * @returns {Promise<void>} Resolves after the browser assertions pass.
 */
async function verifyBrowserExecution(distRoot) {
  const { server, url } = await startStaticServer(distRoot);
  let browser;

  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new Error(
        'Playwright Chromium is unavailable. Run "npm run install:test-browser" first. '
        + `Launch error: ${error.message}`,
        { cause: error },
      );
    }

    const page = await browser.newPage();
    const browserErrors = [];

    page.on('console', message => {
      if (message.type() === 'error') {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', error => browserErrors.push(error.stack || error.message));

    const response = await page.goto(url, { waitUntil: 'networkidle' });

    assert.ok(response?.ok(), `Browser request failed with status ${response?.status()}`);
    await page.waitForFunction(() => document.documentElement.dataset.installedPackageTest);
    assert.equal(
      await page.locator('html').getAttribute('data-installed-package-test'),
      'passed',
      await page.locator('#result').textContent(),
    );

    assert.deepEqual(JSON.parse(await page.locator('#result').textContent()), {
      resourceType: 'Questionnaire',
      itemType: 'string',
      status: 'ok',
    });
    assert.deepEqual(browserErrors, []);
  } finally {
    if (browser) {
      await browser.close();
    }
    await closeServer(server);
  }
}

/**
 * Run the complete installed-package correctness check.
 *
 * @returns {Promise<void>} Resolves after all checks pass.
 */
async function main() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fml-resource-version-converter-installed-'),
  );

  try {
    const tarballPath = packProject(temporaryRoot);
    const consumerRoot = installPackage(temporaryRoot, tarballPath);

    verifyNodeConsumer(consumerRoot);
    writeBrowserConsumer(consumerRoot);

    const distRoot = await buildBrowserConsumer(consumerRoot);

    verifyBrowserBundle(consumerRoot, distRoot);
    await verifyBrowserExecution(distRoot);
    process.stdout.write('Installed package passed Node, Vite, and browser checks.\n');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
