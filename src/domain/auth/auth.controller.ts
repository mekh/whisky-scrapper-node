import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';

import { AuthConfig } from '~config';
import { HEADER_REFRESH_COOKIE } from '~constants';
import { CurrentUser, Permission, RefreshToken } from '~decorators/auth';
import { ReqIp, ReqUA } from '~decorators/http';
import { Paginated, Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  AuthTokens,
  CookieOptions,
  CtxManager,
  CtxUser,
  Response,
  TypePaginated,
  TypeSession,
} from '~types';

import { AuthService } from './auth.service';
import {
  AuthLoginDto,
  SessionOwnerParamsDto,
  SessionParamsDto,
  SessionQueryDto,
} from './dto';
import { AccessToken, Me, Session } from './types';

const isSelf = (ctx: CtxManager): boolean => {
  const { params } = ctx.getData<{ params: { userId?: string } }>();

  return !!ctx.user &&
    (!params.userId || ctx.user.id.toString() === params.userId);
};

@Controller('auth')
export class AuthController {
  public constructor(
    private readonly authService: AuthService,
    private readonly config: AuthConfig,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Plain(AccessToken, Resource.PUBLIC)
  public async login(
    @Body() data: AuthLoginDto,
    @ReqIp() ip: string,
    @ReqUA() userAgent: string,
    @Res({ passthrough: true }) reply: Response,
  ): Promise<AuthTokens> {
    const tokens = await this.authService.login({
      login: data.login,
      password: data.password,
      ip,
      userAgent,
    });

    this.setRefreshCookie(reply, tokens.refresh);

    return tokens;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Plain(AccessToken, Resource.PUBLIC)
  public async refresh(
    @RefreshToken() refreshToken: string,
    @ReqIp() ip: string,
    @ReqUA() userAgent: string,
    @Res({ passthrough: true }) reply: Response,
  ): Promise<AuthTokens> {
    const tokens = await this.authService.refresh({
      refreshToken,
      ip,
      userAgent,
    });

    this.setRefreshCookie(reply, tokens.refresh);

    return tokens;
  }

  @Get('me')
  @Plain(Me, Resource.AUTHENTICATED)
  public me(@CurrentUser() user: CtxUser): CtxUser {
    return user;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permission(Resource.AUTHENTICATED)
  public async logout(
    @CurrentUser() user: CtxUser,
    @Res({ passthrough: true }) reply: Response,
  ): Promise<void> {
    await this.authService.logout(user, user.sid);

    this.clearRefreshCookie(reply);
  }

  @Get('session')
  @Paginated(
    Session,
    [Resource.SESSION, Action.READ],
    [Resource.SELF, isSelf],
  )
  public ownSessions(
    @CurrentUser() user: CtxUser,
    @Query() query: SessionQueryDto,
  ): Promise<TypePaginated<TypeSession>> {
    return this.authService.getSessions(user.id, query.limit, query.page);
  }

  @Get('session/:userId')
  @Paginated(
    Session,
    [Resource.SESSION, Action.READ],
    [Resource.SELF, isSelf],
  )
  public userSessions(
    @Param() params: SessionOwnerParamsDto,
    @Query() query: SessionQueryDto,
  ): Promise<TypePaginated<TypeSession>> {
    return this.authService.getSessions(
      params.userId,
      query.limit,
      query.page,
    );
  }

  @Delete('session/:userId/:sid')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permission(
    [Resource.SESSION, Action.DELETE],
    [Resource.SELF, isSelf],
  )
  public async revokeSession(
    @Param() params: SessionParamsDto,
  ): Promise<void> {
    await this.authService.revokeSession(params.userId, params.sid);
  }

  private setRefreshCookie(reply: Response, token: string): void {
    reply.setCookie(HEADER_REFRESH_COOKIE, token, this.cookieOptions());
  }

  private clearRefreshCookie(reply: Response): void {
    reply.clearCookie(HEADER_REFRESH_COOKIE, { path: '/' });
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: this.config.refreshExpiresInSec,
    };
  }
}
