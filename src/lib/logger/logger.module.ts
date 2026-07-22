import { DynamicModule, Global, Module } from '@nestjs/common';
import {
  PINO_CONFIG_TOKEN,
  PinoModule,
  PinoOptions,
  PinoService,
} from '@toxicoder/nestjs-pino';
import path from 'node:path';
import { LogFn, Logger } from 'pino';

import { ClsService } from '~app/context';
import { LoggerConfig } from '~config';

interface Config {
  dbLogging?: boolean;
}

@Global()
@Module({
  imports: [
    PinoModule,
    LoggerModule.configure(),
  ],
})
export class LoggerModule {
  public static configure(config?: Config): DynamicModule {
    const opts = {
      dbLogging: config?.dbLogging ?? true,
    };

    return {
      imports: [PinoModule],
      module: LoggerModule,
      providers: [
        {
          inject: [ClsService],
          provide: PINO_CONFIG_TOKEN,
          useFactory: this.getFactory(opts),
        },
        PinoService,
      ],
      exports: [PinoService],
    };
  }

  public static getFactory(
    config: Config,
  ): (...args: any[]) => PinoOptions {
    const baseConfig: PinoOptions = {
      ...LoggerConfig.create(),
      dbLogging: config.dbLogging,
      relativeTo: path.resolve(process.cwd()),
    };

    return (): PinoOptions => ({
      ...baseConfig,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      hooks: { logMethod: this.logMethod },
      redact: {
        paths: [
          'password',
          'body.password',
          'token',
          'accessToken',
          'access.token',
          'refreshToken',
          'refresh.token',
          'meta.accessToken',
          'meta.refreshToken',
        ],
        censor: '***',
      },
    });
  }

  private static logMethod(
    this: Logger,
    args: Parameters<LogFn>,
    method: LogFn,
  ): void {
    const message = args.at(0);
    const context = args.at(-1);
    if (
      args.length < 2
      || typeof context !== 'string'
      || typeof message !== 'string'
    ) {
      return method.apply(this, args);
    }

    const msg = [context, message].join(': ');
    const maybeObj = args.at(1);
    if (
      args.length === 3
      && maybeObj
      && typeof maybeObj === 'object'
      && !message.includes('%')
    ) {
      const obj: any = args[1];
      if (obj instanceof Error) {
        method.call(this, msg);
        // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
        return method.call<Logger, any, void>(this, obj);
      }
      return method.apply(this, [`${msg} %o`, args[1]]);
    }

    method.apply(this, [msg, ...(args as any[]).slice(1, -1)]);
  }
}
