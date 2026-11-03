ARG NODE_IMAGE=node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
FROM ${NODE_IMAGE}
WORKDIR /app
COPY runtime/evaluations/package.json runtime/evaluations/package-lock.json runtime/evaluations/
RUN npm ci --prefix runtime/evaluations --ignore-scripts --registry=https://registry.npmjs.org && npm cache clean --force
COPY runtime/evaluations/embedding-runtime.mjs runtime/evaluations/embedding-model.lock.json runtime/evaluations/local-config.mjs runtime/evaluations/container-service.mjs runtime/evaluations/
COPY LICENSE ./LICENSE
COPY --from=embedding_model --chown=10001:10001 /model/config.json /model/tokenizer.json /model/tokenizer_config.json /model/special_tokens_map.json /model/vocab.txt .runtime/embedding-eval/model/
COPY --from=embedding_model --chown=10001:10001 /model/onnx/model_quantized.onnx .runtime/embedding-eval/model/onnx/model_quantized.onnx
RUN node --input-type=module -e "import {verifyEmbeddingModel} from './runtime/evaluations/embedding-runtime.mjs'; await verifyEmbeddingModel('.runtime/embedding-eval');"
ENV NODE_ENV=production HYPER_EMBEDDING_CONFIG=/run/secrets/embedding_config HYPER_EMBEDDING_BIND_HOST=0.0.0.0
USER 10001:10001
EXPOSE 3116
CMD ["node", "runtime/evaluations/container-service.mjs", "--serve"]
