# Single file, zero dependencies: the runtime image is just Node plus server.mjs.
FROM node:24-alpine

RUN addgroup -g 10001 -S bigfile && adduser -u 10001 -S -G bigfile bigfile

WORKDIR /app
COPY server.mjs ./

USER bigfile
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8099)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
