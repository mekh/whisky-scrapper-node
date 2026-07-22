import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { ContextManager } from '~app/context';

export const ReqUA = createParamDecorator<boolean>(
  (_: unknown, context: ExecutionContext): string => {
    return ContextManager.create(context).manager.userAgent;
  },
);
