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
  app.enableCors();

  // Cookie parser is required to read the refresh token from the `refresh`
  // cookie on the auth endpoints.
  await app.register(cookie);

  // Security headers (HSTS, X-Frame-Options, Referrer-Policy, noSniff, ...).
  // The CSP is relaxed just enough for the Swagger UI at /docs to keep working;
  // the SPA's own CSP is set by the reverse proxy that serves the built app.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle(config.appName)
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(config.port, config.host);
};

run().catch((error: unknown) => {
  console.error('app is failed to start', error);
  process.exit(1);
});
