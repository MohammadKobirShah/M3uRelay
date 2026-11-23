# syntax=docker/dockerfile:1
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# No npm dependencies: the relay is plain Node.js. Nothing to install.
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY panel ./panel
COPY scripts ./scripts
COPY demo ./demo
COPY channels.m3u channels.demo.m3u ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
