// Copie les fichiers de l'appli web dans www/ pour l'APK (Capacitor).
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const FILES = ['index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'vendor'];

rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of FILES) cpSync(f, `www/${f}`, { recursive: true });
console.log('www/ prêt');
