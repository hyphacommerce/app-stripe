# The app on Node, over SQLite in /data. Build the bundle first (it inlines the Hypha SDK
# packages, which live in the sibling Hypha checkout for now):
#
#   pnpm install && pnpm build:node
#   docker build -t hypha-app-stripe .
#   docker run -p 3000:3000 -v stripe-data:/data \
#     -e APP_URL=https://stripe.apps.example.com -e APP_ENCRYPTION_KEY=$(openssl rand -hex 32) \
#     hypha-app-stripe
ARG NODE_IMAGE=node:24-trixie-slim
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/stripe-app.sqlite
WORKDIR /app
COPY dist/server.js dist/server.js.map ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "server.js"]
