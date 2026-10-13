# Cobro automático con Mercado Pago

## Cómo funciona

Al cobrar por **Transferencia / QR**, **Débito** o **Crédito**, la venta queda *esperando el pago*. La app consulta cada ~2,5 s los pagos aprobados de tu cuenta de Mercado Pago. Cuando aparece **exactamente uno** por el monto del cobro y de los últimos minutos, lo da por cobrado, lo muestra con su "tarjetita" y completa la venta. Si hay **más de uno** por el mismo monto, no adivina: muestra a los pagadores para que la persona de caja elija.

- Para **QR**, la venta queda como *Transferencia*.
- Para **tarjeta**, el débito/crédito lo define Mercado Pago (no el botón que se tocó).
- Cada pago de Mercado Pago se puede usar **una sola vez** (no se cobra dos ventas con el mismo pago).

Funciona con el **QR del mostrador** (el cliente escribe el monto y paga) y con un **posnet Mercado Pago Point**, porque en ambos casos el dinero cae en la misma cuenta. **Un posnet de otro banco (Prisma, Fiserv, etc.) no se integra**: ahí se confirma a mano.

## Configuración (5 minutos)

1. Entrá a [Mercado Pago Developers](https://www.mercadopago.com.ar/developers) → **Tus integraciones** → creá una aplicación.
2. En **Credenciales de producción** copiá el **Access Token** (empieza con `APP_USR-`).
3. En la app: **Administración → Configuración → Mercado Pago**: pegá el token, activá la opción y tocá **Probar conexión**. Tiene que decir *Conexión correcta* y mostrar tu cuenta.
4. **Hacé un cobro real de prueba** por un monto chico (ej. $100) con tu propio celular antes de usarlo con clientes.

## Qué pasa si se corta internet

Es la limitación de fondo: confirmar un pago de Mercado Pago **requiere internet**. Sin conexión:

- La pantalla de cobro avisa *"Sin conexión con Mercado Pago"*.
- Si la persona de caja **ya vio el pago en su celular**, toca **Confirmar a mano**. La venta sigue y queda marcada con ✋ y en el cierre aparece *"N cobros confirmados a mano: verificalos contra Mercado Pago"*.
- El efectivo no depende de internet.

## Límites y riesgos

- **Dos clientes pagando el mismo monto casi a la vez** → la app lo detecta y pide elegir. Si no se elige bien, un pago puede quedar asignado a la venta equivocada (el total de caja igual cierra).
- Un pago aprobado **en los últimos 3 minutos** (configurable) por el mismo monto, que no se asoció a ninguna venta, puede tomarse como el cobro actual. Pasa si antes se confirmó a mano un pago por el mismo monto. Es la razón de marcar los cobros manuales para revisarlos.
- El **Access Token se guarda en texto plano** en la base de datos local (`datos/mrcook.sqlite`). Quien tenga acceso a esa PC tiene acceso al token. Alternativa: definir la variable de entorno `MP_ACCESS_TOKEN` en vez de guardarlo. Nunca lo subas a un repositorio.
- Las **devoluciones** (anular una venta cobrada por QR/tarjeta) no se hacen desde la app: hay que devolver el dinero desde Mercado Pago o el posnet. La app avisa al anular.

## Qué se verificó y qué no

Probado con respuestas simuladas de la API (confirmación, monto distinto, pago ya usado, varios candidatos, pago viejo, sin conexión, token inválido). **No se probó contra la API real de Mercado Pago**: el entorno de desarrollo no tenía acceso a su documentación ni a una cuenta. La integración usa solo `GET /v1/payments/search` (con `sort`, `criteria`, `status`, `limit`) y `GET /users/me`, y filtra monto/fecha en la propia app para depender lo menos posible de parámetros. El botón **Probar conexión** ejecuta ambas consultas, así que un error de credenciales o de parámetros aparece al configurar y no frente al cliente.
