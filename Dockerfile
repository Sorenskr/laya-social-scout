# 云托管 / 任意电脑容器一键跑起来
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY main.js ./
COPY index.html ./
COPY style.css ./
COPY app.js ./
COPY .nojekyll ./
COPY api ./api
COPY lib ./lib

RUN mkdir -p /app/data /app/covers

ENV PORT=80
ENV NODE_ENV=production

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||80)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "main.js"]
