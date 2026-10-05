import { NotFoundException, type PipeTransform } from '@nestjs/common';
import { ulidSchema } from '@videochat/shared';

/** Like UuidParamPipe, for message ids (ULIDs): a malformed id is a plain 404, not a 500. */
export class UlidParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!ulidSchema.safeParse(value).success) throw new NotFoundException('Not found');
    return value;
  }
}
