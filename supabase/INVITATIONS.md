# Invitaciones de usuario

El panel `/protected/access` permite que root invite una dirección de correo. La invitación crea una cuenta de Supabase Auth sin perfil ni sucursales. Después de aceptar el enlace y establecer una contraseña, root asigna sus permisos desde el panel.

## Variables del servidor

Configura estas variables en `.env.local` para desarrollo y en el entorno del servidor para producción:

```dotenv
APP_URL=http://localhost:3000
SUPABASE_SECRET_KEY=sb_secret_...
```

Usa una secret key creada desde Supabase API Keys. `SUPABASE_SECRET_KEY` es solo de servidor; nunca la renombres con el prefijo `NEXT_PUBLIC_`, la incluyas en el bundle del navegador ni la guardes en el repositorio.

## Supabase Auth

- En Auth > URL Configuration, configura Site URL y agrega a Redirect URLs la ruta de aceptación: `http://localhost:3000/auth/accept-invite` (usa el dominio real en producción).
- En Auth > Email Templates > Invite user, usa el contenido de `supabase/templates/invite.html`. El enlace abre una página de aceptación; el token se verifica solo cuando la persona pulsa el botón, para evitar que los filtros de correo consuman la invitación al revisar el enlace.
- Configura SMTP propio para entregar invitaciones a usuarios reales.
- Para que las cuentas solo se creen por invitación, desactiva el registro público en Auth. La invitación se envía mediante la operación administrativa de Auth.

La plantilla local se configura en `supabase/config.toml`. Ese archivo no cambia la configuración de un proyecto Supabase alojado; actualiza allí la plantilla y las URLs por separado.
