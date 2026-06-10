# QTI

Sitio de generacion de imagenes con dashboard administrativo.

## Variables necesarias

- `GEMINI_API_KEY`: clave para generar imagenes.
- `ADMIN_USER`: usuario administrador.
- `ADMIN_PASSWORD`: contrasena administrador.
- `ADMIN_SECRET`: secreto largo para firmar sesiones del dashboard.

En local, si no se configuran `ADMIN_USER` y `ADMIN_PASSWORD`, el servidor usa `admin` / `admin` solo para pruebas. En produccion el acceso queda deshabilitado si faltan esas variables.

## Dashboard

El acceso esta en `/admin.html` y tambien desde el candado sutil de la pagina publica. Las imagenes generadas y las metricas se guardan en:

- Local: carpeta `data/`.
- Netlify: Netlify Blobs, con el store `qti-admin`.
