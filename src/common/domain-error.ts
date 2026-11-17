/** An error whose message is meant for the client; the status says who is at fault. */
export class DomainError extends Error {
    constructor(
        message: string,
        readonly status: number = 400
    ) {
        super(message);
        this.name = new.target.name;
    }
}

export class UnauthorizedError extends DomainError {
    constructor(message: string) {
        super(message, 401);
    }
}

export class ForbiddenError extends DomainError {
    constructor(message: string) {
        super(message, 403);
    }
}

export class NotFoundError extends DomainError {
    constructor(message: string) {
        super(message, 404);
    }
}

/** A third party failed; the client gets a 502 and the message says what could not be done. */
export class UpstreamError extends DomainError {
    constructor(message: string) {
        super(message, 502);
    }
}
