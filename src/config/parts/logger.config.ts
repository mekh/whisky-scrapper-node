import { Injectable } from '@nestjs/common';
import { PinoConfig } from '@toxicoder/nestjs-pino';

@Injectable()
export class LoggerConfig extends PinoConfig {}
