import 'dotenv/config';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { initializeTransactionalContext } from 'typeorm-transactional';

import { AppModule } from '~app/app.module';
import { AppConfig } from '~config';
import { LoggerService } from '~lib/logger';

initializeTransactionalContext();

const run = async (): Promise<void> => {
  const config = new AppConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  app.useLogger(app.get(LoggerService));
  app.enableVersioning({ type: VersioningType.URI });

  /**
   * Restrict CORS to the configured origins instead of the previous
   * wildcard. Dev (vite proxy) and prod (nginx) both call the API
   * same-origin, so CORS is only a safety net; set CORS_ORIGINS to widen it.
   */
  app.enableCors({ origin: config.corsOrigins });

  // Cookie parser is required to read the refresh token from the `refresh`
  // cookie on the auth endpoints.
  await app.register(cookie);

  /**
   * Security headers are owned by the reverse proxy. It sets CSP, HSTS,
   * X-Frame-Options, X-Content-Type-Options and Referrer-Policy with
   * `always` on every response, the API's included: `location /api/`
   * carries no `add_header` of its own and so inherits the server-level
   * ones. nginx *appends* rather than replaces, so leaving those five
   * enabled here sent each of them twice and made X-Frame-Options
   * self-contradictory (helmet's SAMEORIGIN beside nginx's DENY, which
   * some browsers resolve by honouring neither).
   *
   * What stays on is exactly what nginx does not send: the cross-origin
   * isolation pair, Origin-Agent-Cluster and the legacy X-* hardening
   * headers.
   *
   * The consequence to keep in mind: those five headers are absent
   * whenever the API is reached without the proxy — dev through the Vite
   * proxy, and the Swagger UI on 127.0.0.1, which is also what lets
   * /docs render now that no CSP reaches it. A new deployment topology
   * must set them at its own edge.
   */
  await app.register(helmet, {
    contentSecurityPolicy: false,
    referrerPolicy: false,
    strictTransportSecurity: false,
    xContentTypeOptions: false,
    xFrameOptions: false,
  });

  /**
   * Swagger UI (/docs) and the OpenAPI spec (/docs-json) are mounted only
   * when explicitly enabled. They are registered on the Fastify instance
   * directly, so the global auth guards do NOT protect them — leave them off
   * in production (SWAGGER_ENABLED unset) and enable them in dev only, where
   * `pnpm openapi` snapshots /docs-json for the frontend codegen.
   */
  if (config.swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(config.appName)
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    SwaggerModule.setup('docs', app, document);
  }

  /**
   * Lets Nest run `onModuleDestroy`/`beforeApplicationShutdown` on SIGTERM, so
   * a deploy stops the app cleanly; an in-flight sync's lock is released by
   * the boot sweep of the next process.
   */
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
};

run().catch((error: unknown) => {
  console.error('app is failed to start', error);
  process.exit(1);
});
