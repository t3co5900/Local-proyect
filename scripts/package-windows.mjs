// Arma el paquete portátil para Windows: una carpeta (y un .zip) con
//   node\node.exe            -> Node.js oficial (verificado con SHA-256)
//   app\                     -> servidor + interfaz compilada + dependencias de producción
//   Iniciar Mr.Cook.bat      -> doble clic: arranca y abre la ventana
//   datos\                   -> (se crea al usar) base de datos y respaldos
//
// Todas las dependencias son JavaScript puro (SQLite viene dentro de Node), así
// que el paquete se puede armar desde Linux/Mac/Windows sin compilar nada.
//
//   npm run package:win [-- --node-version=22.22.0 --skip-node --no-zip]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nodeVersion = String(args['node-version'] || process.version.replace(/^v/, ''));
const outDir = path.resolve(root, args.out || 'release');
const stage = path.join(outDir, 'MrCook-POS');
const cache = path.join(outDir, '.cache');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const log = (m) => console.log(`• ${m}`);

if (Number(nodeVersion.split('.')[0]) < 22 || (nodeVersion.startsWith('22.') && Number(nodeVersion.split('.')[1]) < 13)) {
  throw new Error(`Hace falta Node 22.13 o más (el SQLite integrado): se pidió ${nodeVersion}`);
}

// 1. interfaz compilada
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  log('Compilando la interfaz…');
  execFileSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

// 2. carpeta limpia
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'app'), { recursive: true });

// 3. código (sin tests) + interfaz + dependencias de producción
log('Copiando el programa…');
fs.cpSync(path.join(root, 'server'), path.join(stage, 'app', 'server'), {
  recursive: true,
  filter: (src) => !src.split(path.sep).includes('test'),
});
fs.cpSync(path.join(root, 'web', 'dist'), path.join(stage, 'app', 'web', 'dist'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'app', 'package.json'));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'app', 'package-lock.json'));
log('Instalando dependencias de producción…');
execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: path.join(stage, 'app'), stdio: 'inherit', shell: process.platform === 'win32',
});

// 4. node.exe
if (!args['skip-node']) {
  const url = `https://nodejs.org/dist/v${nodeVersion}`;
  fs.mkdirSync(cache, { recursive: true });
  const exe = path.join(cache, `node-v${nodeVersion}-win-x64.exe`);
  if (!fs.existsSync(exe)) {
    log(`Descargando Node.js ${nodeVersion} para Windows…`);
    const res = await fetch(`${url}/win-x64/node.exe`);
    if (!res.ok) throw new Error(`No se pudo bajar node.exe (${res.status})`);
    fs.writeFileSync(exe, Buffer.from(await res.arrayBuffer()));
  }
  const sums = await (await fetch(`${url}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  if (!expected || expected !== actual) {
    fs.rmSync(exe, { force: true });
    throw new Error('El node.exe descargado no coincide con el SHA-256 oficial: se descartó.');
  }
  log('node.exe verificado (SHA-256 oficial).');
  fs.mkdirSync(path.join(stage, 'node'), { recursive: true });
  fs.copyFileSync(exe, path.join(stage, 'node', 'node.exe'));
}

// 5. lanzadores (los .bat/.txt se escriben con saltos de línea de Windows)
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
for (const f of fs.readdirSync(path.join(root, 'scripts', 'windows'))) {
  const src = path.join(root, 'scripts', 'windows', f);
  const dst = path.join(stage, f);
  if (f.endsWith('.bat')) fs.writeFileSync(dst, crlf(fs.readFileSync(src, 'utf8')));
  else fs.copyFileSync(src, dst);
}
const readme = fs.readFileSync(path.join(root, 'docs', 'LEEME-PAQUETE.txt'), 'utf8').replace('{{VERSION}}', pkg.version);
fs.writeFileSync(path.join(stage, 'LEEME.txt'), `\ufeff${crlf(readme)}`);

// 6. zip
const zipName = `MrCook-POS-${pkg.version}-win-x64.zip`;
const zipPath = path.join(outDir, zipName);
fs.rmSync(zipPath, { force: true });
if (!args['no-zip']) {
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}'`], { stdio: 'inherit' });
    } else {
      execFileSync('zip', ['-qr', zipName, 'MrCook-POS'], { cwd: outDir, stdio: 'inherit' });
    }
    log(`Listo: ${zipPath}`);
  } catch {
    log(`No se pudo crear el .zip (¿falta "zip"?). La carpeta está lista: ${stage}`);
  }
} else {
  log(`Listo: ${stage}`);
}
