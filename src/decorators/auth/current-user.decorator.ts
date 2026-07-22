import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { ContextManager } from '~app/context';
import { NotAuthenticatedError } from '~errors';
import { CtxUser } from '~types';

export const CurrentUser = createParamDecorator<boolean>(
  (throwIfNotFound = true, context: ExecutionContext): CtxUser | null => {
    const { user } = ContextManager.create(context);

    if (!user && throwIfNotFound) {
      throw new NotAuthenticatedError();
    }

    return user ?? null;
  },
);
