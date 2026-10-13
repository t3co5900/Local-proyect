# Presentación para la dueña del local

`docs/Mr.Cook-POS-presentacion.pdf` explica el programa sin tecnicismos: qué es, cómo se usa un día completo, cómo se cierra la caja, el stock, el personal, qué se cambia desde Administración y qué está probado y qué no. Todas las pantallas son del programa real con **datos de demostración** (nada de un local verdadero).

## Qué hay en esta carpeta

| Archivo | Para qué sirve |
|---|---|
| `slides.json` | El contenido: una entrada por diapositiva (texto, diagrama, imagen con recorte y números). Es lo único que hay que tocar para cambiar un texto. |
| `render-slides.mjs`, `deck.css` | Diseño de cada tipo de diapositiva (amarillo, negro y blanco, tipografía Nunito). |
| `build-deck.mjs` | Arma el PDF (Chromium imprime las diapositivas en 1280×720) y avisa si algo se sale de la hoja. |
| `assets/` | Las capturas en JPEG (`jpg/`), el logo y `manifest.json` con el alto y ancho de cada una. |
| `assets/facts.json` | Las cifras de la semana de demostración, para chequear que los textos coinciden. |

## Regenerar el PDF

```bash
npm install
node docs/presentacion/build-deck.mjs \
  --slides=docs/presentacion/slides.json \
  --out=docs/Mr.Cook-POS-presentacion.pdf \
  --preview=/tmp/vista-previa      # opcional: un PNG por diapositiva
```

Necesita Chromium (variable `CHROMIUM_PATH` si no está en el lugar habitual). Si una diapositiva se sale de la hoja, el programa termina con código 3 y lista cuáles.

## Rehacer las capturas

1. `node scripts/demo/seed-demo.mjs --out=<carpeta>/demoA --today=none` y lo mismo con `demoB --today=open`.
2. `npm run build` y `node scripts/demo/capture-screens.mjs <carpeta>`.
3. Convertir las capturas a JPEG en `assets/jpg/` y completar `width`/`height` de cada una en `assets/manifest.json`. Ese paso de conversión no está automatizado.
