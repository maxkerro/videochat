import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  claimKeyPackagesSchema,
  createE2eeGroupSchema,
  registerE2eeDeviceSchema,
  uploadKeyPackagesSchema,
  welcomesQuerySchema,
  type ClaimKeyPackagesInput,
  type ClaimedKeyPackages,
  type CreateE2eeGroupInput,
  type E2eeDevice,
  type E2eeGroup,
  type E2eeWelcome,
  type RegisterE2eeDeviceInput,
  type UploadKeyPackagesInput,
} from '@videochat/shared';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { E2eeThrottlerGuard } from '../rate-limit/rate-limit.guards.js';
import { E2eeService } from './e2ee.service.js';

/** CHAT-076 (spike): the end-to-end encryption key directory. 404 everywhere unless the
 *  `E2EE_PROTOTYPE` flag is on. */
@Controller('e2ee')
@UseGuards(AccessTokenGuard)
export class E2eeController {
  constructor(private readonly e2ee: E2eeService) {}

  /** Whether the prototype is switched on, so the web app knows to offer it. */
  @Get('status')
  status(): { enabled: boolean } {
    return { enabled: this.e2ee.enabled };
  }

  @Post('devices')
  @UseGuards(E2eeThrottlerGuard)
  register(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(registerE2eeDeviceSchema)) _body: RegisterE2eeDeviceInput,
  ): Promise<E2eeDevice> {
    return this.e2ee.registerDevice(userId);
  }

  @Get('devices/:deviceId/key-packages')
  countKeyPackages(
    @CurrentUserId() userId: string,
    @Param('deviceId', UuidParamPipe) deviceId: string,
  ): Promise<{ count: number }> {
    return this.e2ee.keyPackageCount(userId, deviceId);
  }

  @Post('devices/:deviceId/key-packages')
  uploadKeyPackages(
    @CurrentUserId() userId: string,
    @Param('deviceId', UuidParamPipe) deviceId: string,
    @Body(new ZodValidationPipe(uploadKeyPackagesSchema)) body: UploadKeyPackagesInput,
  ): Promise<{ count: number }> {
    return this.e2ee.uploadKeyPackages(userId, deviceId, body.keyPackages);
  }

  @Post('conversations/:conversationId/key-packages/claim')
  @HttpCode(200)
  @UseGuards(E2eeThrottlerGuard)
  claim(
    @CurrentUserId() userId: string,
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @Body(new ZodValidationPipe(claimKeyPackagesSchema)) body: ClaimKeyPackagesInput,
  ): Promise<ClaimedKeyPackages> {
    return this.e2ee.claim(userId, conversationId, body.deviceId);
  }

  @Get('conversations/:conversationId/group')
  getGroup(
    @CurrentUserId() userId: string,
    @Param('conversationId', UuidParamPipe) conversationId: string,
  ): Promise<{ group: E2eeGroup | null }> {
    return this.e2ee.getGroup(userId, conversationId);
  }

  @Post('conversations/:conversationId/group')
  @UseGuards(E2eeThrottlerGuard)
  createGroup(
    @CurrentUserId() userId: string,
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @Body(new ZodValidationPipe(createE2eeGroupSchema)) body: CreateE2eeGroupInput,
  ): Promise<E2eeGroup> {
    return this.e2ee.createGroup(userId, conversationId, body);
  }

  @Get('welcomes')
  welcomes(
    @CurrentUserId() userId: string,
    @Query(new ZodValidationPipe(welcomesQuerySchema)) query: { deviceId: string },
  ): Promise<{ welcomes: E2eeWelcome[] }> {
    return this.e2ee.welcomes(userId, query.deviceId);
  }

  @Delete('welcomes/:id')
  @HttpCode(204)
  deleteWelcome(
    @CurrentUserId() userId: string,
    @Param('id', UuidParamPipe) id: string,
  ): Promise<void> {
    return this.e2ee.deleteWelcome(userId, id);
  }
}
