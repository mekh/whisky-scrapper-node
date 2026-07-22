import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { ContextManager } from '~app/context';

export const ReqIp = createParamDecorator<boolean>(
  (_: unknown, context: ExecutionContext): string => {
    return ContextManager.create(context).manager.ip;
  },
);
