# Deploy en Hetzner — guía paso a paso

Para cuando tengas el teléfono del bot a mano. La idea es dejar todo esto
hecho antes, para que en ese momento el único paso pendiente sea escanear
el QR.

## 1. Crear el servidor

En [Hetzner Cloud Console](https://console.hetzner.cloud):

- **Ubicación**: Ashburn, VA (US East) -- es la región de Hetzner más cercana
  a Ecuador, mejor latencia que las europeas.
- **Imagen**: Ubuntu 24.04 LTS (cualquier Ubuntu LTS reciente que ofrezca
  sirve igual -- los pasos de abajo no dependen de la versión exacta).
- **Tipo**: CX22 (2 vCPU, 4 GB RAM) -- sobra para un solo proceso Node con
  una conexión WebSocket. ~€4.59/mes.
- **Autenticación**: SSH key en vez de contraseña. Si no tenés una:
  ```
  ssh-keygen -t ed25519 -C "whatsapp-agent"
  ```
  (en PowerShell o Git Bash de Windows funciona igual -- OpenSSH viene
  incluido). Subís la pública (`~/.ssh/id_ed25519.pub`) al crear el
  servidor.
- **Firewall** (Hetzner Cloud Firewall, se configura aparte del servidor):
  permitir entrante solo TCP 22 (SSH). El proceso no necesita recibir
  conexiones entrantes -- solo abre conexiones salientes hacia Supabase,
  Gemini y WhatsApp.

## 2. Conexión inicial

```
ssh root@<IP_DEL_SERVIDOR>
apt update && apt upgrade -y
```

Opcional pero recomendado -- usuario no-root para correr el servicio:
```
adduser deploy
usermod -aG sudo deploy
su - deploy
```

## 3. Instalar Node.js 20+ y pm2

```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
node -v   # confirmar 20.x o superior
sudo npm install -g pm2
```

## 4. Llevar el código al servidor

**Recomendado -- Git.** El `.gitignore` del proyecto ya excluye
`node_modules/`, `auth_state/` y `.env`, así que es seguro pushear a un
repo (privado):

```
# en tu máquina, dentro de agente/
git init
git add .
git commit -m "Setup inicial del agente de WhatsApp"
# creá un repo privado en GitHub y seguí las instrucciones de git remote add / push que te da
```

```
# en el VPS
git clone <URL_DE_TU_REPO> whatsapp-agent
cd whatsapp-agent
```

**Alternativa rápida sin Git** (si todavía no querés crear un repo):
```
# desde tu máquina Windows, en PowerShell o Git Bash
scp -r agente deploy@<IP_DEL_SERVIDOR>:~/whatsapp-agent
```
(esto copia `node_modules` de más si existe localmente -- mejor borrarlo
antes o excluirlo con `rsync -av --exclude node_modules --exclude auth_state agente/ deploy@<IP>:~/whatsapp-agent/`)

## 5. Variables de entorno

El `.env` real **nunca** va por Git. Subilo aparte, directo al servidor:

```
scp agente/.env deploy@<IP_DEL_SERVIDOR>:~/whatsapp-agent/.env
```

## 6. Instalar dependencias y verificar antes de levantar

```
cd ~/whatsapp-agent
npm install
npm run typecheck
npm run verify   # chequeo de humo contra Supabase y Gemini reales -- confirma que el .env está bien antes de meter WhatsApp en la ecuación
```

Si `npm run verify` da "Todo OK." (los mismos 8 chequeos que corrí acá),
el servidor está listo para conectar WhatsApp.

## 7. Levantar con pm2

```
pm2 start "npm run start" --name whatsapp-agent
pm2 logs whatsapp-agent
```

El QR aparece ahí mismo, en los logs de pm2. Escaneálo desde el WhatsApp
**dedicado del bot**.

Una vez conectado (`Conectado a WhatsApp.` en los logs), dejalo persistente:
```
pm2 save
pm2 startup
```
`pm2 startup` imprime un comando `sudo env PATH=...` -- copiálo y corrélo
tal cual para que pm2 resucite el proceso solo si el servidor se reinicia.

## 8. Verificación post-deploy

- Mandá un mensaje de prueba desde otro teléfono al número del bot.
- `pm2 logs whatsapp-agent` para ver el flujo en vivo (interpretación,
  match de producto, respuesta enviada).
- `pm2 status` -- confirmá que queda en estado `online`, no
  `errored`/`stopped`.

## 9. Actualizaciones futuras

```
cd ~/whatsapp-agent
git pull            # o volver a scp/rsync si no usás git
npm install         # solo si cambiaron las dependencias
pm2 restart whatsapp-agent
```

`pm2 logs whatsapp-agent --lines 200` para ver historial reciente,
`pm2 monit` para uso de CPU/memoria en vivo.

## Costo estimado

CX22 ~€4.59/mes. No hace falta nada más (sin balanceador, sin volumen
aparte -- el respaldo de sesión ya vive en Supabase Storage, no en disco
del VPS).
