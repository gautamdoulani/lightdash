import { LightdashError, UnexpectedServerError } from '@lightdash/common';
import { ValidateError } from 'tsoa';

export const errorHandler = (error: Error): LightdashError => {
    if (error instanceof ValidateError) {
        return new LightdashError({
            statusCode: 422,
            name: error.name,
            message: error.message,
            data: error.fields,
        });
    }
    if (error instanceof LightdashError) {
        return error;
    }
    return new UnexpectedServerError(`${error}`);
};
