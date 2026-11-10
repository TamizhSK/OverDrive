FROM public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace=@servicecare/api --ignore-scripts
COPY packages/contracts packages/contracts
COPY backend backend
RUN npm run build:visual -w @servicecare/api
RUN node -e "require('sharp'); console.log('Linux image decoder loaded')"

FROM public.ecr.aws/lambda/nodejs:22
COPY --from=build /repo/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /repo/backend/dist/visual ${LAMBDA_TASK_ROOT}/
CMD ["lambda.handler"]