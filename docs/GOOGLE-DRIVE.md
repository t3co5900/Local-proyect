# Respaldo semanal en Google Drive

Cada semana (lunes a domingo) la app genera, dentro de `datos\backups\AAAA-Wnn\`:

- `MrCook_Resumen-semanal_AAAA-Wnn.xlsx`: ingresos por medio de pago (efectivo / transferencia / débito / crédito / total), ventas por día, productos vendidos, **stock inicial, ingresos de mercadería, vendido y final**, turnos y horas trabajadas.
- `MrCook_base-de-datos_AAAA-Wnn.sqlite`: copia completa de la base.

Además hay una **copia diaria** de la base (`datos\backups\diario`, últimos 14 días). Si la PC estaba apagada el lunes, el respaldo semanal se genera apenas se prende.

Hay dos formas de llevarlo a tu Drive. **Empezá por la A.**

## Opción A (recomendada): Google Drive para ordenador

1. Instalá [Google Drive para ordenador](https://www.google.com/drive/download/) en la PC del local e ingresá con tu cuenta (la de Google One).
2. Creá dentro de *Mi unidad* una carpeta, por ejemplo `Mr.Cook Respaldos`.
3. En la app: **Administración → Configuración → Respaldos** → *Carpeta de respaldos en esta PC* = esa carpeta (ej. `G:\Mi unidad\Mr.Cook Respaldos`).

Listo: Drive sube los archivos solo. Sin credenciales, sin tokens que venzan. Es más robusto que la opción B.

## Opción B: subida directa por API

Útil si no querés instalar Drive en la PC. Sube a una carpeta **"Mr.Cook Backups"** que la app crea en tu Drive (con el permiso mínimo `drive.file`, la app solo ve lo que ella misma crea; por eso no usa una carpeta que vos hayas creado).

1. [Google Cloud Console](https://console.cloud.google.com/) → creá un proyecto → **APIs y servicios → Biblioteca** → activá **Google Drive API**.
2. **Pantalla de consentimiento de OAuth** → tipo **Externo** → completá nombre y tu email → en *Permisos* agregá `.../auth/drive.file`.
3. ⚠️ **Publicá la app** (*Publicar aplicación* → "En producción"). Si queda en modo *Prueba*, **Google vence el permiso a los 7 días** y los respaldos dejan de subirse en silencio.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación de escritorio**. Copiá **Client ID** y **Client Secret**.
5. En la app: **Administración → Configuración → Respaldos y Google Drive**: pegalos, **Guardar** y tocá **Conectar Google Drive**. Google te pide permiso y vuelve a la app.
6. Probalo con **Administración → Respaldos → Hacer respaldo de esta semana ahora**. Tiene que aparecer *Correcto* y la carpeta en tu Drive.

### Por qué no se usa una cuenta de servicio

Una *service account* **no tiene cuota de almacenamiento** en un Drive personal: Google rechaza las subidas. Solo funcionaría con una unidad compartida de Google Workspace.

## Si la subida falla

El respaldo **local se guarda igual**. El estado queda como *"Local OK, Drive falló"* en **Administración → Respaldos** y la app reintenta cada hora (hasta 12 veces). Causas típicas: sin internet, permiso vencido o revocado (reconectá), o app en modo *Prueba*.

## Restaurar

1. `Detener Mr.Cook.bat`.
2. Copiá el `.sqlite` de la semana elegida sobre `datos\mrcook.sqlite` (borrá antes `mrcook.sqlite-wal` y `mrcook.sqlite-shm` si existen).
3. `Iniciar Mr.Cook.bat`.

## Qué se verificó y qué no

La subida está probada con respuestas simuladas de Google (renovación de token, creación de carpeta, subida de dos archivos, reemplazo de un archivo existente, caída de red con respaldo local intacto). **No se probó contra Google real**: no había credenciales disponibles. Antes de confiar en la opción B, hacé el paso 6 y mirá tu Drive.
