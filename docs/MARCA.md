# Identidad visual (franquicia)

La app usa **amarillo, negro y blanco** y el logo de Mr.Cook que se proporcionó. Hay dos cosas que son **provisorias** y conviene reemplazar con los archivos oficiales de la franquicia.

## 1. Tipografía — pendiente

El manual de marca no estaba disponible, así que **no se pudo identificar la tipografía oficial** de "Mr.Cook". La del logo parece una sans-serif redondeada y gruesa (tipo Gotham Rounded / Nunito Black), pero eso es una **suposición** a partir de una imagen de baja resolución. Mientras tanto se usa **Nunito** (licencia libre SIL OFL), que está incluida en el programa para que funcione sin internet.

Para usar la oficial, pedile a la franquicia el archivo de la fuente (`.woff2` o `.ttf` / `.otf`, con licencia de uso en web y en documentos) y:

- **Pantalla**: copiá los archivos a `web/src/fonts/`, declarálos con `@font-face` al principio de `web/src/styles.css` y cambiá **una sola línea**: `--font-brand: 'NombreDeLaFuente', system-ui, sans-serif;` (borrá los `@import '@fontsource/nunito/...'`).
- **PDF del cierre**: reemplazá `server/assets/fonts/nunito-400.ttf`, `nunito-700.ttf` y `nunito-900.ttf` por las versiones TTF de la oficial en pesos equivalentes (normal, negrita, extra negrita; pdfkit no admite fuentes variables).
- **Excel**: usa Calibri (la que trae Excel). Cambiarla por una de marca obliga a que esté instalada en cada PC que lo abra; no se recomienda.

Después: `npm run build`.

## 2. Logo — pendiente en mayor resolución

El archivo recibido es de **447 × 447 px con compresión visible**. Se lo procesó (fondo transparente, versión blanca y negra, escalado ×2) y se ve bien a tamaño de barra superior, pero **se nota blando** en el login y en el PDF. Pedí el **logo vectorial (SVG/AI/PDF) o un PNG de al menos 1500 px** y reemplazá:

- `web/public/logo-white.png` — barra superior y login (logo blanco sobre fondo oscuro)
- `web/public/logo-black.png`, `web/public/favicon.png`, `scripts/windows/mrcook.ico` — otros usos
- `server/assets/logo-white.png` — encabezado de Excel y PDF

## Colores

Definidos al principio de `web/src/styles.css`. El amarillo `#FFCB05` y el negro `#181816` se tomaron a ojo del logo y del pedido; si la franquicia tiene códigos oficiales, se cambian en `--yellow` y `--ink` (y en `server/exports/xlsx.js` / `pdf.js`, constantes `YELLOW` e `INK`).
