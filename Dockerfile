# Five stages. `app` is deliberately the last one, so a plain `docker build .`
# - and compose - still produce the runtime image; the two CI gates are
# branches off the same layers and are reached only with `--target`.
#
#   docker build --target web-test     .   frontend lint + Vitest
#   docker build --target backend-test .   the image, plus pytest and tests/
#   docker build                       .   the runtime image
#
# Both gates share the caller's build cache with the runtime image, so a Jenkins
# run resolves npm and pip exactly once and tests the dependency set that is
# about to be pushed rather than a separately-resolved CI environment.

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
# `npm run build` is `tsc -b && vite build`, so a type error fails the image
# build here - typecheck is not a gate that can be skipped.
RUN npm run build


# ---------- stage 2: the frontend CI gate ----------
# `FROM web` reuses the install and the build above as cache; only the checks
# the image build does not already perform run here. Nothing pushes this stage,
# and nothing downstream depends on it - `docker build .` never reaches it.
FROM web AS web-test
RUN npm run lint && npm test


# ---------- stage 3: the application, without its entrypoint ----------
# Split from `app` only so the backend gate can branch off it while leaving the
# runtime image last in the file.
FROM python:3.11-slim AS base

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


# ---------- stage 4: the backend CI gate ----------
# `FROM base` carries frontend/dist with it, which tests/test_frontend.py reads:
# the shipped bundle's routing and its secret scan are checked against the
# artefact that is about to be pushed, not against a host build.
#
# pytest is deliberately absent from requirements.txt so it cannot reach the
# runtime image. It is installed here, in a stage nothing pushes.
#
# Nothing is run at build time. Most of the suite needs PostgreSQL, and without
# it 395 of 437 tests skip while the build still goes green - so the run belongs
# where a database can be attached to it. Jenkins runs this image against a
# throwaway pgvector container; see Jenkinsfile.
FROM base AS backend-test
RUN pip install pytest==8.3.4
COPY tests ./tests
CMD ["python", "-m", "pytest", "tests", "-q"]


# ---------- stage 5: the runtime image ----------
# Last on purpose: this is what `docker build .` with no --target produces.
FROM base AS app
VOLUME ["/models", "/app/data"]
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
