import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { ContextManager } from '~app/context';
import { NotAuthenticatedError } from '~errors';

export const RefreshToken = createParamDecorator<boolean>(
  (throwIfNotFound = true, context: ExecutionContext): string | undefined => {
    const { refreshToken } = ContextManager.create(context);

    if (!refreshToken && throwIfNotFound) {
      throw new NotAuthenticatedError();
    }

    return refreshToken;
  },
);
