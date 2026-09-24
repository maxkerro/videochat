import { NotFoundException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

const uuidSchema = z.uuid();

/**
 * Validates a route param that's used to look up a row by a `uuid` primary key (e.g.
 * `:conversationId`). Without this, a malformed id (not a UUID at all) reaches the database
 * driver, which throws an "invalid input syntax for type uuid" error that surfaces as an
 * unhandled 500 instead of the 404 a not-found id would get -- an inconsistency that also leaks
 * that the id "looks wrong" in a different way than "doesn't exist", which the 404-for-
 * non-members pattern used throughout this codebase is meant to avoid.
 */
export class UuidParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!uuidSchema.safeParse(value).success) {
      throw new NotFoundException('Not found');
    }
    return value;
  }
}
