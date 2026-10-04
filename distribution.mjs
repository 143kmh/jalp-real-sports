// Explicit allowlists. Never package the working directory wholesale.
export const runtimeFiles = [
  'package.json', 'package-lock.json', 'README.md', 'launcher-server.mjs',
  'server.mjs', 'core.mjs', 'storage.mjs', 'vault.ps1', 'automation.mjs',
  'general-runner.mjs', 'browser-accounts.mjs', 'owned-browser.mjs',
  'owned-realm.mjs', 'command-notifier.mjs', 'diagnostics.mjs',
  'public/index.html', 'public/app.js', 'public/style.css',
  'helium-extension/navigation.js', 'helium-extension/pack-listing.js',
  'helium-extension/workflow.js', 'helium-extension/real.js',
];
export const sourceFiles = [
  ...runtimeFiles, '.gitignore', 'Launcher.cs', 'build-windows.ps1',
  'package-windows.mjs', 'distribution.mjs', 'launch.ps1', 'Запустить Real Manager.cmd',
  'test.mjs', 'browser-test.mjs', 'navigation-test.mjs', 'delivery-test.mjs',
  'automation-test.mjs', 'pack-listing-test.mjs', 'player-pack-test.mjs',
  'ui-test.mjs', 'general-runner-test.mjs', 'owned-browser-test.mjs',
  'browser-accounts-test.mjs', 'distribution-test.mjs',
  'helium-extension/background.js', 'helium-extension/panel.js', 'helium-extension/manifest.json',
];
export function safeDistributionPath(name) {
  return !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..') &&
    !/(^|\/)(data|browser-profile|panel-profile|\.git)(\/|$)|\.(har|dpapi|log|png|jpe?g|webp)$/i.test(name);
}
