import { ID } from './entity.interfaces';

export interface AccessJwt {
  sub: ID;
  sid: string;
  admin: boolean;
  scope: string;
}
