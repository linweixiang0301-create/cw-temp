import { Design006BrowserManager } from './design006-browser-manager.js';

const url = process.argv[2] || 'https://www.design006.com/detail-99213334643';
const manager = new Design006BrowserManager();
const candidate = await manager.resolve(url);
console.log(JSON.stringify(candidate, null, 2));
