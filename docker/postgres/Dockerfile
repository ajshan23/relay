# Postgres 17 (Alpine, same as before so the existing data volume keeps working) plus pgvector,
# which the AI agent's knowledge search needs. Supabase already has pgvector.
FROM postgres:17-alpine
ARG PGVECTOR_VERSION=0.8.1
RUN apk add --no-cache --virtual .build git build-base \
 && git clone --depth 1 --branch v${PGVECTOR_VERSION} https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && cd /tmp/pgvector && make with_llvm=no OPTFLAGS="" && make install with_llvm=no \
 && cd / && rm -rf /tmp/pgvector && apk del .build
