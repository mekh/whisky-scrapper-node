import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import { READ_CACHE_MAX_AGE_SECONDS } from '~constants';
import { CurrentUser } from '~decorators/auth';
import { CacheControl, ReqUA } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  CtxUser,
  PushClientConfig,
  PushDevices,
  PushDispatchReport,
} from '~types';

import { PushDispatchDto, PushSubscribeDto, PushUnsubscribeDto } from './dto';
import { PushDigestService } from './push-digest.service';
import { PushService } from './push.service';
import {
  PushConfigType,
  PushDevicesType,
  PushDispatchReportType,
} from './types';

/**
 * `POST /push/digest` reuses `store:sync` rather than adding a `Resource`
 * value: the permission to start a sync is already the permission to cause a
 * dispatch, and a new enum member would surface a row in the permissions
 * editor for no gain.
 */
@Controller('push')
export class PushController {
  public constructor(
    private readonly push: PushService,
    private readonly digest: PushDigestService,
  ) {}

  @Get('config')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(PushConfigType, Resource.AUTHENTICATED)
  public config(): PushClientConfig {
    return this.push.clientConfig();
  }

  @Get('subscription')
  @CacheControl('no-cache')
  @Plain(PushDevicesType, Resource.AUTHENTICATED)
  public devices(@CurrentUser() user: CtxUser): Promise<PushDevices> {
    return this.push.devices(user.id);
  }

  @Post('subscription')
  @HttpCode(HttpStatus.OK)
  @Plain(PushDevicesType, Resource.AUTHENTICATED)
  public subscribe(
    @CurrentUser() user: CtxUser,
    @Body() body: PushSubscribeDto,
    @ReqUA() userAgent: string,
  ): Promise<PushDevices> {
    return this.push.subscribe(user.id, body, userAgent);
  }

  @Delete('subscription')
  @Plain(PushDevicesType, Resource.AUTHENTICATED)
  public unsubscribe(
    @CurrentUser() user: CtxUser,
    @Body() body: PushUnsubscribeDto,
  ): Promise<PushDevices> {
    return this.push.unsubscribe(user.id, body.endpoint);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @Plain(PushDispatchReportType, Resource.AUTHENTICATED)
  public test(@CurrentUser() user: CtxUser): Promise<PushDispatchReport> {
    return this.push.sendTest(user.id);
  }

  @Post('digest')
  @HttpCode(HttpStatus.OK)
  @Plain(PushDispatchReportType, [Resource.STORE, Action.SYNC])
  public dispatch(
    @Body() body: PushDispatchDto,
  ): Promise<PushDispatchReport> {
    return this.digest.dispatch(body);
  }
}
