import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRIDGE_ROOT } from './config.js';

function bridgeUrl(relativePath: string): string {
  return pathToFileURL(path.join(BRIDGE_ROOT, relativePath)).href;
}

export async function loadDesign006Bridge(): Promise<any> {
  return import(bridgeUrl('src/photoshop-design006.ts'));
}

export async function loadManagedChromeBridge(): Promise<any> {
  return import(bridgeUrl('src/managed-chrome-runtime.ts'));
}

export async function loadBrowserCdpBridge(): Promise<any> {
  return import(bridgeUrl('src/browser-cdp.ts'));
}

export async function loadPhotoshopConfigBridge(): Promise<any> {
  return import(bridgeUrl('src/photoshop-config.ts'));
}

export async function loadPhotoshopAssetsBridge(): Promise<any> {
  return import(bridgeUrl('src/photoshop-assets.ts'));
}

export async function loadPhotoshopJobsBridge(): Promise<any> {
  return import(bridgeUrl('src/photoshop-jobs.ts'));
}

export async function loadPhotoshopSessionsBridge(): Promise<any> {
  return import(bridgeUrl('src/photoshop-sessions.ts'));
}
