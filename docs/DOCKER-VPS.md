# Docker y VPS (alternativa)

La instalación recomendada es **local en la PC del local** (ver [LEEME-PAQUETE](LEEME-PAQUETE.txt)): es lo que permite seguir cobrando sin internet. Docker sirve para probar, o para tener una copia de demostración.

## Docker

```bash
docker compose up -d --build
# abrir http://localhost:3737
```

Los datos quedan en el volumen `mrcook-data` (base de datos y respaldos). Para sacar un respaldo: `docker compose cp mrcook:/data ./copia-datos`.

> **No probado en este entorno**: el Dockerfile está escrito pero no se pudo construir porque la máquina de desarrollo no tenía Docker. Si falla, el error debería ser pequeño; avisá.

## VPS: lo que tenés que saber antes

Alquilar un VPS **contradice el requisito de seguir vendiendo sin internet**: si se cae la conexión del local, no se puede abrir la pantalla de venta y la caja se detiene. Si de todos modos lo querés (por ejemplo para varios locales o para ver reportes desde casa):

- Publicalo **solo detrás de HTTPS** (Caddy o nginx con certificado) y definí `COOKIE_SECURE=1`. Sin HTTPS el código de 4 dígitos viaja en texto plano.
- Un código de 4 dígitos son solo 10.000 combinaciones. En internet público, con el bloqueo por usuario no alcanza: poné el acceso detrás de una VPN (Tailscale/WireGuard) o de un proxy con autenticación propia.
- Hacé respaldos fuera del servidor (Drive o copia del volumen).
- La confirmación de Mercado Pago funciona igual (consulta desde el servidor).

Mi recomendación: **local para vender, y si hace falta ver datos a distancia, el Excel semanal en Drive**, que ya cubre ese caso sin exponer la caja a internet.
