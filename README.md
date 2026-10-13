# Mr.Cook POS

Sistema de caja para el local: **ventas, turnos, stock, fichaje, cierres y respaldos**. Corre **100 % en la PC del local**, sin internet: si se cae el WiFi se sigue cobrando normalmente.

> Hecho para una sola caja por local. La interfaz está en español rioplatense y la plata va en pesos argentinos.

## Qué hace

| Área | Detalle |
|---|---|
| **Usuarios** | Ingreso con nombre y apellido (o inicial + apellido) y un **código de 4 dígitos asignado al azar**. Bloqueo de 5 min tras 5 intentos fallidos. Roles: cajero y encargado. |
| **Turnos** | Apertura con efectivo inicial y conteo de stock; retiros/ingresos de efectivo; cierre con efectivo contado (a ciegas para el cajero) y conteo de stock. Un solo turno abierto a la vez. |
| **Venta** | Productos por unidad y **promos** (combos a precio fijo: docena, 3 medialunas, empanadas + gaseosa…). Efectivo con vuelto, transferencia/QR, débito, crédito y **pagos mixtos**. Anulación autorizada por un encargado. |
| **Cobro automático** | Con Mercado Pago, el cobro por QR o tarjeta **se confirma solo** y aparece con su "tarjetita" (Transferencia, Débito, Crédito, Efectivo). Si no hay internet, se confirma a mano y queda marcado. Ver [docs/MERCADOPAGO.md](docs/MERCADOPAGO.md). |
| **Stock** | Libro de movimientos (ingresos, ventas, anulaciones, mermas, ajustes, conteos). En cada cierre: **inicio + ingresos − vendido ± ajustes = final**, con el contado y la diferencia. |
| **Cierre de turno** | Resumen en pantalla, **Excel con fórmulas**, **PDF** e **impresión**: quién fue el encargado, qué se vendió y cuánto, cobros por medio de pago (digital / efectivo / total), control de caja e inventario. |
| **Fichaje** | Entrada y salida con usuario + código, sin necesidad de abrir turno. Horas por persona y corrección de fichajes olvidados. |
| **Respaldos** | Copia diaria de la base (14 días) y **resumen semanal** (Excel + copia de la base) en `datos\backups`, con subida opcional a **Google Drive**. Si la PC estuvo apagada el lunes, se pone al día solo. Ver [docs/GOOGLE-DRIVE.md](docs/GOOGLE-DRIVE.md). |
| **Auditoría** | Quién anuló una venta, cambió un precio, ajustó stock, etc. |

## Instalar en el local (Windows)

1. Descargá `MrCook-POS-<versión>-win-x64.zip` (se genera con `npm run package:win`, ver abajo, o desde la pestaña *Actions* del repositorio).
2. Descomprimilo en `C:\MrCook`.
3. Doble clic en **Iniciar Mr.Cook.bat**.

Guía completa en [docs/LEEME-PAQUETE.txt](docs/LEEME-PAQUETE.txt) (viaja dentro del zip).

## Desarrollo

Requiere **Node 22.13 o más** (usa el SQLite integrado de Node, sin módulos nativos).

```bash
npm install
npm run build        # compila la interfaz (web/dist)
npm start            # http://127.0.0.1:3737

# desarrollo con recarga
npm run dev:server   # API en :3737
npm run dev:web      # interfaz en :5173 (proxy a la API)

npm test             # 42 tests del servidor
node scripts/e2e-smoke.mjs        # recorrido completo en un navegador real (necesita Chromium)
node scripts/e2e-mercadopago.mjs  # cobro automático contra un Mercado Pago simulado
npm run package:win  # arma release/MrCook-POS-<versión>-win-x64.zip
```

Variables de entorno (todas opcionales): `PORT` (3737), `HOST` (127.0.0.1), `MRCOOK_DATA_DIR` (`./data`), `TZ_NEGOCIO` (America/Argentina/Buenos_Aires), `SESSION_HOURS` (12 h de inactividad), `COOKIE_SECURE=1` (solo detrás de HTTPS), `MP_ACCESS_TOKEN`, `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`.

## Decisiones de diseño

- **Local primero.** SQLite en un archivo (`datos/mrcook.sqlite`), servidor Node en `127.0.0.1`. Nada depende de internet para vender.
- **La plata son enteros en centavos**, nunca decimales de punto flotante.
- **El stock sale de un libro de movimientos.** `products.stock` es solo un caché que se actualiza en la misma transacción; el stock de cualquier fecha se puede reconstruir.
- **Cada operación es una transacción.** Una venta que falla no deja stock descontado ni ventas a medias.
- **El PIN de 4 dígitos protege por el bloqueo, no por el cifrado.** Se guarda con scrypt, pero 10.000 combinaciones se rompen rápido si alguien copia el archivo de la base: por eso el bloqueo y por eso la PC del local es la barrera real. No es un sistema pensado para exponerse a internet.
- **Mercado Pago por conciliación, no por webhooks.** La PC del local no tiene URL pública, así que la app consulta los pagos recientes de la cuenta y confirma el que coincide en monto y hora.

## Estructura

```
server/            API (Express 5), servicios, exportación Excel/PDF, tests
  services/        usuarios, turnos, ventas, stock, cobros, reportes, respaldos, Drive
  exports/         generación de Excel (exceljs) y PDF (pdfkit)
web/               interfaz (React + Vite), sin dependencias de internet (fuentes locales)
scripts/           paquete de Windows, lanzadores .bat, prueba de humo con navegador
docs/              guías: Mercado Pago, Google Drive, marca, Docker/VPS
```

## Límites conocidos

- Una sola caja por local (un turno abierto a la vez).
- No imprime tickets en impresora térmica ni emite facturas fiscales (AFIP/ARCA).
- Sin descuentos manuales: los descuentos se hacen con promos.
- La integración con Mercado Pago y la subida a Drive están probadas con respuestas simuladas, **no contra las cuentas reales** (ver los documentos de cada una).
- Un posnet de un banco distinto de Mercado Pago no se puede integrar: se confirma a mano.
