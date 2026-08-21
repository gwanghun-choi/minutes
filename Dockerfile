# ---------- stage 1: build the React frontend ----------
# Node exists only here. Nothing from this stage but `dist` reaches the runtime
# image: no node, no npm, no node_modules, no frontend source.
FROM node:22-slim AS web

WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
# `npm ci` installs exactly the lockfile, so the image build is reproducible.
#
# The CA mount is the build-time twin of the runtime bundle compose already
# mounts: behind a TLS-inspecting corporate proxy the registry's chain is
# re-signed, and Node ignores the system store, so npm fails with
# SELF_SIGNED_CERT_IN_CHAIN. The secret is optional - where no proxy intercepts,
# the file is simply absent and npm uses its own roots. Nothing is baked into
# the layer either way.
RUN --mount=type=secret,id=ca_bundle,target=/tmp/ca-bundle.crt \
    if [ -s /tmp/ca-bundle.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/ca-bundle.crt; fi; \
    npm ci --no-audit --no-fund
COPY frontend/ ./
# `npm run build` is `tsc -b && vite build` - a type error fails the image build.
RUN npm run build


# ---------- stage 2: the application image ----------
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    TORCH_HOME=/models/torch

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY scripts ./scripts
# app.main serves this directory: index.html for every client route, hashed
# assets beside it.
COPY --from=web /web/dist ./frontend/dist

# requests/huggingface_hub default to certifi, which ignores the system store.
# Point them at it so a mounted host CA bundle (TLS-inspecting proxy) is trusted.
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

RUN mkdir -p /models /app/data/uploads
VOLUME ["/models", "/app/data"]
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
