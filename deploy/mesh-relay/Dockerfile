# TokenBank 官方中继：和每个 app 里的中继是同一份代码（client/electron/mesh/relay.js）。
# 构建上下文是仓库根目录：docker compose --profile mesh build mesh-relay
FROM node:22.21-bookworm-slim
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund ws@8.20.0
COPY client/electron/mesh/relay-server.js client/electron/mesh/relay.js client/electron/mesh/identity.js client/electron/mesh/keys.js ./
USER node
ENV PORT=8790
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "relay-server.js"]
