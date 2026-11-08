# Latido — monitor de uptime para agencias web

Prototipo navegable de un micro SaaS de monitorización de uptime pensado para agencias y freelancers web de habla hispana: vigila las webs de sus clientes, explica cada caída en lenguaje claro, avisa por WhatsApp, Telegram o email y da a cada cliente una página de estado con la marca de la agencia.

> **Es un prototipo estático.** No hay servidor: el inicio de sesión, los pagos, el CAPTCHA y los emails están simulados en el navegador. Sirve para ver y probar la experiencia antes de construir el backend.

## Verlo

- Abre `index.html` con doble clic, o publícalo con GitHub Pages (Settings → Pages → rama `main`, carpeta raíz).
- Cuenta de demostración: `demo@latido.example` / `latido-demo-2026`.

## Qué incluye

| Vista | Ruta |
|---|---|
| Portada, funciones, seguridad, precios y preguntas | `#/` |
| Registro con verificación de email | `#/registro` |
| Inicio de sesión y recuperación de contraseña | `#/login`, `#/recuperar` |
| Confirmación de pago | `#/checkout?plan=agencia` |
| Panel de monitores, webhooks y cuenta | `#/app` |
| Página de estado pública de un cliente | `#/estado` |
| Términos, privacidad, cookies y aviso legal | `#/terminos`, `#/privacidad`, `#/cookies`, `#/aviso-legal` |

## Planes

| Plan | Precio | Monitores | Intervalo mínimo | Alertas |
|---|---|---|---|---|
| Gratis | 0 $ | 5 | 5 min | Email |
| Freelancer | 9 $/mes | 30 | 60 s | Email, Telegram, WhatsApp |
| Agencia | 29 $/mes | 150 | 30 s | Todo + 50 SMS/mes y webhooks |

Pago anual con un 20 % de descuento.

## Seguridad que ya funciona en el prototipo

- **Filtro anti-SSRF** (`ssrf-guard.js`): solo http/https, sin credenciales en la URL; bloquea redes privadas, loopback, link-local, metadatos de la nube, IPv6 privadas, IPv4 mapeadas en IPv6 y NAT64. Incluye `resolveAndCheck()` para el servidor, que resuelve el DNS antes de cada comprobación y tras cada redirección.
- **Contraseñas filtradas**: el registro consulta Have I Been Pwned con k-anonimidad (solo salen los 5 primeros caracteres del hash SHA-1).
- **Límites por plan**: monitores por cuenta, intervalo mínimo y monitores por dominio.
- **Webhooks firmados** con HMAC-SHA256 y pasados por el mismo filtro anti-SSRF.
- **XSS**: todo lo que escribe el usuario se pinta con `textContent`, y hay una cabecera Content-Security-Policy sin scripts en línea.
- **Login**: mensaje genérico ante fallos, CAPTCHA tras 3 intentos y bloqueo temporal tras 5.

En producción todas estas reglas deben repetirse en el servidor: lo que valida el navegador es solo ayuda para el usuario.

## Monitor real (fase 0: prueba privada)

`monitor/` vigila una web de verdad: la comprueba cada 5 minutos, guarda el historial en SQLite (`monitor/data.db`) y avisa por email con [Resend](https://resend.com) cuando se cae y cuando vuelve. Cada caída se confirma con una segunda comprobación 20 s después. Necesita Node 22.5 o superior, sin dependencias.

```bash
cp .env.example .env        # y rellénalo
node --env-file=.env monitor/run.mjs            # vigila sin parar
node --env-file=.env monitor/run.mjs --once     # una sola comprobación
node monitor/run.mjs --history                  # historial y uptime
```

## Pruebas

```bash
node test-ssrf.cjs
node monitor/test.mjs
```

## Pendiente para producción

- Servidor con login de un proveedor probado (por ejemplo Supabase Auth), sesiones en cookies `HttpOnly; Secure; SameSite=Lax` y 2FA real.
- Pagos con Paddle y activación del plan solo al recibir su webhook con firma verificada.
- Comprobadores en máquinas aisladas, sin acceso a la base de datos.
- Cabeceras HSTS y CSP enviadas por el servidor o por Cloudflare (GitHub Pages no permite cabeceras propias).
- Revisar los textos legales con un abogado y completar los datos del titular en el aviso legal.
- Comprobar que el nombre "Latido" no está registrado como marca.
