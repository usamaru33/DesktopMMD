// Electron entry point (skill mmd-architecture §7).
import { app } from 'electron';
import { App } from './App';
import { registerSchemes } from './windows/protocol';

registerSchemes();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const main = new App();
  if (!main.s.render.hardwareAcceleration) app.disableHardwareAcceleration();
  // transparent windows on some GPUs need this to avoid a black background (spec 8.4)
  app.commandLine.appendSwitch('enable-transparent-visuals');

  app.on('second-instance', () => main.showCharacter());
  app.on('window-all-closed', () => {
    /* stay resident in the tray */
  });
  app
    .whenReady()
    .then(() => main.start())
    .catch((e) => {
      console.error('startup failed', e);
      app.exit(1);
    });
  app.on('before-quit', () => main.quit());
}
