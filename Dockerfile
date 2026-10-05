# Broker only. The agent is not containerised: it has to reach apps on the
# host's own loopback, which a container deliberately cannot see.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Long-lived agent sockets must survive a rolling deploy, so give the process
# a chance to drain rather than killing it instantly.
STOPSIGNAL SIGTERM
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/broker/index.js"]
