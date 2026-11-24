/** The figures of the landing page: the names of the launched offerings and of the providers that have them. */
export interface Figures {
    services: string[];
    organizations: string[];
}

export interface StoredFigures extends Figures {
    /** When they were read; a document that v11 wrote has no date. */
    computedAt?: Date;
}

/** Where the figures are kept, shared by the replicas. */
export abstract class StatsStore {
    abstract latest(): Promise<StoredFigures | undefined>;
    /** Replaces the figures: the document is a fixed one, so that two replicas that start together do not make two. */
    abstract save(figures: Figures, computedAt: Date): Promise<void>;
}
