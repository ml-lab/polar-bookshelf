import {
    Datastore, FileMeta, InitResult, SynchronizingDatastore,
    MutationType, FileRef, DocMetaMutation, DocMetaSnapshotEvent,
    DocMetaSnapshotEventListener, SnapshotResult, SyncDocs, SyncDocMap,
    ErrorListener, DocMetaSnapshotEvents, SyncDocMaps, SynchronizationEvent,
    FileSynchronizationEvent, FileSynchronizationEventListener,
    SynchronizationEventListener} from './Datastore';
import {Directories} from './Directories';
import {DocMetaFileRef, DocMetaFileRefs, DocMetaRef} from './DocMetaRef';
import {DeleteResult} from './Datastore';
import {Backend} from './Backend';
import {DatastoreFile} from './DatastoreFile';
import {Optional} from '../util/ts/Optional';
import {DocInfo} from '../metadata/DocInfo';
import {DatastoreMutation, DefaultDatastoreMutation} from './DatastoreMutation';
import {DatastoreMutations} from './DatastoreMutations';
import {UUID} from '../metadata/UUID';
import {Datastores} from './Datastores';
import {DocMeta} from '../metadata/DocMeta';
import {UUIDs} from '../metadata/UUIDs';
import {DocMetas} from '../metadata/DocMetas';
import {Logger} from "../logger/Logger";
import {DocMetaComparisonIndex} from './DocMetaComparisonIndex';
import {PersistenceLayers, SyncOrigin} from './PersistenceLayers';
import {DocMetaSnapshotEventListeners} from './DocMetaSnapshotEventListeners';
import {Latch} from '../util/Latch';
import {NULL_FUNCTION} from '../util/Functions';
import {isUpperCase} from 'tslint/lib/utils';
import {IEventDispatcher, SimpleReactor} from '../reactor/SimpleReactor';

const log = Logger.create();

/**
 * A CloudAwareDatastore allows us to have one datastore with a local copy and
 * remote datastore backing them.  Reads are resolved via the local data store
 * and writes are resolved to both the remote and local concurrently.
 * The reverse is true too. If we startup and there is an excess file in the
 * remote, it's copied local.
 */
export class CloudAwareDatastore implements Datastore, SynchronizingDatastore {

    // allows us to keep track of the snapshot id so that when we report errors
    // we can know which snapshot failed.
    private static SNAPSHOT_ID = 0;

    public readonly id = 'cloud-aware';

    public readonly stashDir: string;

    public readonly logsDir: string;

    public readonly directories: Directories;

    private readonly local: Datastore;

    private readonly cloud: Datastore;

    private readonly fileSynchronizationEventDispatcher: IEventDispatcher<FileSynchronizationEvent> = new SimpleReactor();

    private readonly synchronizationEventDispatcher: IEventDispatcher<SynchronizationEvent> = new SimpleReactor();

    // FIXME: isn't this like a fancy SyncDocMap ? Should I just be using this
    // or the SyncDocMap???
    private readonly docMetaComparisonIndex = new DocMetaComparisonIndex();

    private primarySnapshot?: SnapshotResult;

    constructor(local: Datastore, cloud: Datastore) {
        this.local = local;
        this.cloud = cloud;
        this.stashDir = local.stashDir;
        this.logsDir = local.logsDir;
        this.directories = local.directories;
    }

    public async init(errorListener: ErrorListener = NULL_FUNCTION): Promise<InitResult> {

        await Promise.all([this.cloud.init(errorListener), this.local.init(errorListener)]);

        this.primarySnapshot = await this.snapshot(NULL_FUNCTION);

        return {};

    }

    public async stop() {

        // TODO: all snapshots that have been handed out should be stopped...

        if (this.primarySnapshot && this.primarySnapshot.unsubscribe) {
            this.primarySnapshot.unsubscribe();
        }

        await Promise.all([this.cloud.stop(), this.local.stop()]);
    }

    public async contains(fingerprint: string): Promise<boolean> {
        return this.local.contains(fingerprint);
    }

    public async getDocMeta(fingerprint: string): Promise<string | null> {
        return this.local.getDocMeta(fingerprint);
    }

    public async writeFile(backend: Backend,
                           ref: FileRef,
                           data: Buffer | string,
                           meta: FileMeta = {}): Promise<DatastoreFile> {

        // for this to work we have to use fierbase snapshot QuerySnapshot and
        // look at docChanges and wait for the document we requested...

        await this.cloud.writeFile(backend, ref, data, meta);

        // TODO: can't we just wait until the event is fired when it's pulled
        // down as part of the normal snapshot mechanism.?  That might be best
        // as we would be adding it twice.
        return this.local.writeFile(backend, ref, data, meta);

    }

    public async getFile(backend: Backend, ref: FileRef): Promise<Optional<DatastoreFile>> {
        return this.local.getFile(backend, ref);
    }

    public containsFile(backend: Backend, ref: FileRef): Promise<boolean> {
        return this.local.containsFile(backend, ref);
    }

    public async deleteFile(backend: Backend, ref: FileRef): Promise<void> {

        await this.cloud.deleteFile(backend, ref);

        return this.local.deleteFile(backend, ref);

    }

    public async delete(docMetaFileRef: DocMetaFileRef,
                        datastoreMutation: DatastoreMutation<boolean> = new DefaultDatastoreMutation()):
        Promise<Readonly<CloudAwareDeleteResult>> {

        try {

            await DatastoreMutations.executeBatchedWrite(datastoreMutation,
                                                         async (remoteCoordinator) => {
                                                             this.cloud.delete(docMetaFileRef, remoteCoordinator);
                                                         },
                                                         async (localCoordinator) => {
                                                             this.local.delete(docMetaFileRef, localCoordinator);
                                                         });
        } finally {
            this.docMetaComparisonIndex.remove(docMetaFileRef.fingerprint);
        }

        // TODO: return the result of the local and remote operations.
        return {};

    }



    public async write(fingerprint: string,
                       data: string,
                       docInfo: DocInfo,
                       datastoreMutation: DatastoreMutation<boolean> = new DefaultDatastoreMutation()): Promise<void> {

        // TODO: return the result of the local and remote operations instead of
        // just void.

        try {

            return DatastoreMutations.executeBatchedWrite(datastoreMutation,
                                                          (remoteCoordinator) =>
                                                              this.cloud.write(fingerprint, data, docInfo, remoteCoordinator),
                                                          (localCoordinator) =>
                                                              this.local.write(fingerprint, data, docInfo, localCoordinator));

        } finally {

            this.docMetaComparisonIndex.putDocInfo(docInfo);

        }

    }

    public async getDocMetaFiles(): Promise<DocMetaRef[]> {
        return this.local.getDocMetaFiles();
    }

    public async snapshot(docMetaSnapshotEventListener: DocMetaSnapshotEventListener,
                          errorListener: ErrorListener = NULL_FUNCTION): Promise<SnapshotResult> {

        const isPrimarySnapshot: boolean = this.primarySnapshot === undefined;

        const snapshotID = CloudAwareDatastore.SNAPSHOT_ID++;

        const localPersistenceLayer = PersistenceLayers.toPersistenceLayer(this.local);
        const cloudPersistenceLayer = PersistenceLayers.toPersistenceLayer(this.cloud);

        const deduplicatedListener = DocMetaSnapshotEventListeners.createDeduplicatedListener(docMetaSnapshotEvent => {
            docMetaSnapshotEventListener(docMetaSnapshotEvent);
        });

        class InitialSnapshotLatch {

            public readonly syncDocMap: SyncDocMap = {};
            public readonly latch = new Latch<boolean>();

            public async handle(docMetaSnapshotEvent: DocMetaSnapshotEvent) {

                const syncDocs = await DocMetaSnapshotEvents.toSyncDocs(docMetaSnapshotEvent);
                SyncDocMaps.putAll(this.syncDocMap, syncDocs);

                if (docMetaSnapshotEvent.consistency === 'committed' &&
                    docMetaSnapshotEvent.batch!.terminated) {

                    this.latch.resolve(true);

                }

            }

            public onSnapshot(docMetaSnapshotEvent: DocMetaSnapshotEvent) {

                this.handle(docMetaSnapshotEvent)
                    .catch(err => {
                        log.error(`Unable to handle event for snapshot: ${snapshotID}`, err);
                        errorListener(err);
                    });

            }

            public createSnapshot(datastore: Datastore) {

                return datastore.snapshot(docMetaSnapshotEvent => {

                    replicatingListener(docMetaSnapshotEvent);

                    if (! initialSyncCompleted) {
                        this.onSnapshot(docMetaSnapshotEvent);
                    }

                }, errorListener);

            }

        }

        let initialSyncCompleted: boolean = false;

        // The way this algorithm works is that we load the local store first
        // and on the first snapshot we keep an index of the fingerprint to
        // UUID... then we wait until we can get the similar index from the
        // 'committed' version of the cloud datastore, then we perform a
        // synchronize based on this metadata... at which point we synchronize
        // both datasources.

        const localInitialSnapshotLatch = new InitialSnapshotLatch();
        const cloudInitialSnapshotLatch = new InitialSnapshotLatch();

        // FIXME: is it possible to get a double write if I call writeDocMeta
        // to the main store and is it writtne a second time when we get the
        // event from the remote instance?  I think we might have to have a
        // 'written' event go through first from the write() method and sent
        // to all outstanding listeners first.

        // FIXME: if the DiskDatastore and other datastores emit events in
        // THEIR snapshots directly then I think we do not need to do anything
        // special.

        const replicatingListener
            = DocMetaSnapshotEventListeners.createDeduplicatedListener(docMetaSnapshotEvent => {

            const handleSnapshotSync = async () => {

                if (docMetaSnapshotEvent.consistency !== 'committed') {
                    return;
                }

                for (const docMetaMutation of docMetaSnapshotEvent.docMetaMutations) {

                    // FIXME: no files are being transferred here... Just DocMeta...

                    if (docMetaMutation.mutationType === 'created' || docMetaMutation.mutationType === 'updated') {
                        const docMeta = await docMetaMutation.docMetaProvider();
                        await localPersistenceLayer.writeDocMeta(docMeta);
                    }

                    if (docMetaMutation.mutationType === 'deleted') {
                        const docInfo = await docMetaMutation.docInfoProvider();
                        const docMetaFileRef = DocMetaFileRefs.createFromDocInfo(docInfo);
                        await localPersistenceLayer.delete(docMetaFileRef);
                    }

                }

                this.synchronizationEventDispatcher.dispatchEvent({
                    ...docMetaSnapshotEvent,
                    dest: 'local'
                });

            };

            const handleEvent = async () => {

                try {

                    if (initialSyncCompleted && isPrimarySnapshot) {
                        await handleSnapshotSync();
                    }

                } finally {
                    // need to pass on these events after the replication.
                    docMetaSnapshotEventListener(docMetaSnapshotEvent);
                }

            };

            handleEvent()
                .catch(err => {
                    log.error(`Unable to handle delta snapshot for snapshot: ${snapshotID}`, err);
                    errorListener(err);
                });

        });

        localInitialSnapshotLatch.createSnapshot(this.local);

        const cloudSnapshotResultPromise = cloudInitialSnapshotLatch.createSnapshot(this.cloud);

        await localInitialSnapshotLatch.latch.get();
        await cloudInitialSnapshotLatch.latch.get();

        const localSyncOrigin: SyncOrigin = {
            persistenceLayer: localPersistenceLayer,
            syncDocMap: localInitialSnapshotLatch.syncDocMap
        };

        const cloudSyncOrigin: SyncOrigin = {
            persistenceLayer: cloudPersistenceLayer,
            syncDocMap: cloudInitialSnapshotLatch.syncDocMap
        };

        if (isPrimarySnapshot) {
            await PersistenceLayers.synchronizeFromSyncDocs(localSyncOrigin, cloudSyncOrigin, deduplicatedListener);
            await PersistenceLayers.synchronizeFromSyncDocs(cloudSyncOrigin, localSyncOrigin, deduplicatedListener);
        }

        initialSyncCompleted = true;

        const cloudSnapshotResult = await cloudSnapshotResultPromise;

        return {
            unsubscribe: cloudSnapshotResult.unsubscribe
        };

    }

    public addFileSynchronizationEventListener(eventListener: FileSynchronizationEventListener): void {
        this.fileSynchronizationEventDispatcher.addEventListener(eventListener);
    }

    public addSynchronizationEventListener(eventListener: SynchronizationEventListener): void {
        this.synchronizationEventDispatcher.addEventListener(eventListener);
    }

}

export interface CloudAwareDeleteResult extends DeleteResult {

}


/**
 * Represents a doc and its UUID.  The UUID is optional though as older docs
 * may not have a doc but in practice almost all docs will have a UUID.
 */
export interface DocUUID {
    fingerprint: string;
    uuid?: UUID;
}
