import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TriliumClient } from '../../src/client/trilium.js';
import { handleNoteTool } from '../../src/tools/notes.js';
import { setupIntegrationTests, stopTriliumContainer } from './setup.js';

describe('TriliumNext ETAPI Integration Tests', () => {
  let client: TriliumClient;

  beforeAll(async () => {
    client = await setupIntegrationTests();
  }, 120000); // 2 minute timeout for container startup

  afterAll(async () => {
    await stopTriliumContainer();
  });

  describe('Notes', () => {
    let createdNoteId: string;
    let createdBranchId: string;

    it('create_note - should create a note under root', async () => {
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Integration Test Note',
        type: 'text',
        content: '<p>Hello from integration test!</p>',
      });

      expect(result.note).toBeDefined();
      expect(result.note.noteId).toBeDefined();
      expect(result.note.title).toBe('Integration Test Note');
      expect(result.note.type).toBe('text');
      expect(result.branch).toBeDefined();
      expect(result.branch.parentNoteId).toBe('root');

      createdNoteId = result.note.noteId;
      createdBranchId = result.branch.branchId;
    });

    it('create_note - should create code note with mime type', async () => {
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'JavaScript Code Note',
        type: 'code',
        content: 'console.log("Hello, World!");',
        mime: 'application/javascript',
      });

      expect(result.note.type).toBe('code');
      expect(result.note.mime).toBe('application/javascript');
    });

    it('create_note - should handle special characters in title', async () => {
      const specialTitle = 'Test Note: "Quotes" & <Brackets>';
      const result = await client.createNote({
        parentNoteId: 'root',
        title: specialTitle,
        type: 'text',
        content: '<p>Content</p>',
      });

      expect(result.note.title).toBe(specialTitle);
    });

    it('create_note - should handle empty content', async () => {
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Empty Content Note',
        type: 'text',
        content: '',
      });

      const content = await client.getNoteContent(result.note.noteId);
      expect(content).toBe('');
    });

    it('get_note - should retrieve note metadata', async () => {
      const note = await client.getNote(createdNoteId);

      expect(note.noteId).toBe(createdNoteId);
      expect(note.title).toBe('Integration Test Note');
      expect(note.type).toBe('text');
      expect(note.parentNoteIds).toContain('root');
    });

    it('get_note_content - should retrieve note content', async () => {
      const content = await client.getNoteContent(createdNoteId);

      expect(content).toBe('<p>Hello from integration test!</p>');
    });

    it('update_note - should update note title', async () => {
      const updated = await client.updateNote(createdNoteId, {
        title: 'Updated Test Note',
      });

      expect(updated.noteId).toBe(createdNoteId);
      expect(updated.title).toBe('Updated Test Note');
    });

    it('update_note - should update note type and mime', async () => {
      // Create a note specifically for type change testing
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Type Change Test',
        type: 'text',
        content: 'print("hello")',
      });

      const updated = await client.updateNote(result.note.noteId, {
        type: 'code',
        mime: 'text/x-python',
      });

      expect(updated.type).toBe('code');
      expect(updated.mime).toBe('text/x-python');
    });

    it('update_note_content - should update note content', async () => {
      await client.updateNoteContent(createdNoteId, '<p>Updated content!</p>');

      const content = await client.getNoteContent(createdNoteId);
      expect(content).toBe('<p>Updated content!</p>');
    });

    it('update_note_content - should handle large content', async () => {
      const largeContent = '<p>' + 'Lorem ipsum dolor sit amet. '.repeat(1000) + '</p>';
      await client.updateNoteContent(createdNoteId, largeContent);

      const content = await client.getNoteContent(createdNoteId);
      expect(content).toBe(largeContent);
    });

    it('delete_note - should delete the note', async () => {
      // Create a note specifically for deletion
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Note to Delete',
        type: 'text',
        content: '<p>This will be deleted</p>',
      });

      await client.deleteNote(result.note.noteId);

      // Verify note is deleted (should throw)
      await expect(client.getNote(result.note.noteId)).rejects.toThrow();
    });
  });

  describe('Search', () => {
    let searchableNoteId: string;
    let searchableNoteWithLabel: string;
    let parentForSubtreeSearch: string;

    beforeAll(async () => {
      // Create a note to search for
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Searchable Unique Test Note',
        type: 'text',
        content: '<p>This note contains unique searchable content xyz123</p>',
      });
      searchableNoteId = result.note.noteId;

      // Create a parent for subtree search
      const parent = await client.createNote({
        parentNoteId: 'root',
        title: 'Search Subtree Parent',
        type: 'text',
        content: '<p>Parent</p>',
      });
      parentForSubtreeSearch = parent.note.noteId;

      // Create child note with label for filtered search
      const labeledNote = await client.createNote({
        parentNoteId: parentForSubtreeSearch,
        title: 'Labeled Search Note',
        type: 'text',
        content: '<p>Has a label</p>',
      });
      searchableNoteWithLabel = labeledNote.note.noteId;

      // Add a label to the note
      await client.createAttribute({
        noteId: searchableNoteWithLabel,
        type: 'label',
        name: 'searchTestLabel',
        value: 'searchValue',
      });
    });

    it('search_notes - should find notes by title', async () => {
      const result = await client.searchNotes({
        search: 'Searchable Unique Test Note',
      });

      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.some((n) => n.noteId === searchableNoteId)).toBe(true);
    });

    it('search_notes - should search with fastSearch', async () => {
      const result = await client.searchNotes({
        search: 'Searchable Unique',
        fastSearch: true,
      });

      expect(result.results).toBeDefined();
    });

    it('search_notes - should search by label', async () => {
      const result = await client.searchNotes({
        search: '#searchTestLabel',
      });

      expect(result.results).toBeDefined();
      expect(result.results.some((n) => n.noteId === searchableNoteWithLabel)).toBe(true);
    });

    it('search_notes - should search within ancestor subtree', async () => {
      const result = await client.searchNotes({
        search: 'Labeled Search Note',
        ancestorNoteId: parentForSubtreeSearch,
      });

      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.some((n) => n.noteId === searchableNoteWithLabel)).toBe(true);
    });

    it('search_notes - should limit results', async () => {
      // Create multiple notes
      for (let i = 0; i < 3; i++) {
        await client.createNote({
          parentNoteId: 'root',
          title: `Limit Test Note ${i}`,
          type: 'text',
          content: '<p>Testing limit</p>',
        });
      }

      const result = await client.searchNotes({
        search: 'Limit Test Note',
        limit: 2,
      });

      expect(result.results.length).toBeLessThanOrEqual(2);
    });

    it('search_notes - should order results', async () => {
      // Test that orderBy parameter is accepted
      const result = await client.searchNotes({
        search: 'Limit Test Note',
        orderBy: 'title',
        orderDirection: 'asc',
      });

      expect(result.results).toBeDefined();
      // Note: Trilium's ordering may not always be deterministic for similar titles
    });

    it('get_note_tree - should get children of root', async () => {
      const note = await client.getNote('root');

      expect(note.noteId).toBe('root');
      expect(note.childNoteIds).toBeDefined();
      expect(Array.isArray(note.childNoteIds)).toBe(true);
      expect(note.childNoteIds.length).toBeGreaterThan(0);
    });

    it('get_note_tree - should get children of parent note', async () => {
      const note = await client.getNote(parentForSubtreeSearch);

      expect(note.childNoteIds).toContain(searchableNoteWithLabel);
    });
  });

  describe('Organization', () => {
    let parentNote1Id: string;
    let parentNote2Id: string;
    let childNote1Id: string;
    let childNote1BranchId: string;
    let childNote2Id: string;
    let childNote2BranchId: string;

    beforeAll(async () => {
      // Create two parent notes
      const parent1 = await client.createNote({
        parentNoteId: 'root',
        title: 'Org Test Parent 1',
        type: 'text',
        content: '<p>Parent 1</p>',
      });
      parentNote1Id = parent1.note.noteId;

      const parent2 = await client.createNote({
        parentNoteId: 'root',
        title: 'Org Test Parent 2',
        type: 'text',
        content: '<p>Parent 2</p>',
      });
      parentNote2Id = parent2.note.noteId;

      // Create two children under parent 1 for reorder testing
      const child1 = await client.createNote({
        parentNoteId: parentNote1Id,
        title: 'Child Note 1',
        type: 'text',
        content: '<p>Child 1</p>',
      });
      childNote1Id = child1.note.noteId;
      childNote1BranchId = child1.branch.branchId;

      const child2 = await client.createNote({
        parentNoteId: parentNote1Id,
        title: 'Child Note 2',
        type: 'text',
        content: '<p>Child 2</p>',
      });
      childNote2Id = child2.note.noteId;
      childNote2BranchId = child2.branch.branchId;
    });

    it('clone_note - should clone note to second parent', async () => {
      // Clone child1 to parent2
      const branch = await client.createBranch({
        noteId: childNote1Id,
        parentNoteId: parentNote2Id,
      });

      expect(branch.noteId).toBe(childNote1Id);
      expect(branch.parentNoteId).toBe(parentNote2Id);

      // Verify the note now has two parents
      const note = await client.getNote(childNote1Id);
      expect(note.parentNoteIds).toContain(parentNote1Id);
      expect(note.parentNoteIds).toContain(parentNote2Id);
    });

    it('clone_note - should clone with prefix', async () => {
      const branch = await client.createBranch({
        noteId: childNote2Id,
        parentNoteId: parentNote2Id,
        prefix: 'Reference',
      });

      expect(branch.prefix).toBe('Reference');
      expect(branch.parentNoteId).toBe(parentNote2Id);
    });

    it('move_note - should move note to different parent', async () => {
      // Create a note to move
      const noteToMove = await client.createNote({
        parentNoteId: parentNote1Id,
        title: 'Note to Move',
        type: 'text',
        content: '<p>Moving this note</p>',
      });

      // Move it: create new branch first, then delete old one
      // (If we delete first, note would be deleted when last branch is removed)
      const newBranch = await client.createBranch({
        noteId: noteToMove.note.noteId,
        parentNoteId: parentNote2Id,
      });
      await client.deleteBranch(noteToMove.branch.branchId);

      expect(newBranch.parentNoteId).toBe(parentNote2Id);

      // Verify new parent
      const movedNote = await client.getNote(noteToMove.note.noteId);
      expect(movedNote.parentNoteIds).toContain(parentNote2Id);
      expect(movedNote.parentNoteIds).not.toContain(parentNote1Id);
    });

    it('move_note - should move with prefix', async () => {
      const noteToMove = await client.createNote({
        parentNoteId: parentNote1Id,
        title: 'Note to Move with Prefix',
        type: 'text',
        content: '<p>Moving with prefix</p>',
      });

      const newBranch = await client.createBranch({
        noteId: noteToMove.note.noteId,
        parentNoteId: parentNote2Id,
        prefix: 'Archived',
      });
      await client.deleteBranch(noteToMove.branch.branchId);

      expect(newBranch.prefix).toBe('Archived');
    });

    it('reorder_notes - should change note positions', async () => {
      // Get initial positions
      const branch1Before = await client.getBranch(childNote1BranchId);
      const branch2Before = await client.getBranch(childNote2BranchId);

      // Swap positions: put child2 before child1
      await client.updateBranch(childNote1BranchId, { notePosition: 200 });
      await client.updateBranch(childNote2BranchId, { notePosition: 100 });
      await client.refreshNoteOrdering(parentNote1Id);

      // Verify positions changed
      const branch1After = await client.getBranch(childNote1BranchId);
      const branch2After = await client.getBranch(childNote2BranchId);

      expect(branch2After.notePosition).toBeLessThan(branch1After.notePosition);
    });

    it('delete_branch - should remove a branch while keeping the note', async () => {
      // Create a note with a clone (two branches)
      const note = await client.createNote({
        parentNoteId: parentNote1Id,
        title: 'Note with Two Parents',
        type: 'text',
        content: '<p>This note has two branches</p>',
      });

      // Clone it to parent2
      const secondBranch = await client.createBranch({
        noteId: note.note.noteId,
        parentNoteId: parentNote2Id,
      });

      // Delete the second branch
      await client.deleteBranch(secondBranch.branchId);

      // Note should still exist with only first parent
      const noteAfter = await client.getNote(note.note.noteId);
      expect(noteAfter.parentNoteIds).toContain(parentNote1Id);
      expect(noteAfter.parentNoteIds).not.toContain(parentNote2Id);
    });
  });

  describe('Attributes', () => {
    let testNoteId: string;
    let createdAttributeId: string;
    let inheritableAttributeId: string;

    beforeAll(async () => {
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Attribute Test Note',
        type: 'text',
        content: '<p>Testing attributes</p>',
      });
      testNoteId = result.note.noteId;
    });

    it('set_attribute - should add a label to note', async () => {
      const attribute = await client.createAttribute({
        noteId: testNoteId,
        type: 'label',
        name: 'testLabel',
        value: 'testValue',
      });

      expect(attribute.noteId).toBe(testNoteId);
      expect(attribute.type).toBe('label');
      expect(attribute.name).toBe('testLabel');
      expect(attribute.value).toBe('testValue');

      createdAttributeId = attribute.attributeId;
    });

    it('set_attribute - should create inheritable label', async () => {
      const attribute = await client.createAttribute({
        noteId: testNoteId,
        type: 'label',
        name: 'inheritableLabel',
        value: 'inherited',
        isInheritable: true,
      });

      expect(attribute.isInheritable).toBe(true);
      inheritableAttributeId = attribute.attributeId;
    });

    it('set_attribute - should create relation attribute', async () => {
      // Create a target note for the relation
      const targetNote = await client.createNote({
        parentNoteId: 'root',
        title: 'Relation Target',
        type: 'text',
        content: '<p>Target</p>',
      });

      const attribute = await client.createAttribute({
        noteId: testNoteId,
        type: 'relation',
        name: 'relatedTo',
        value: targetNote.note.noteId,
      });

      expect(attribute.type).toBe('relation');
      expect(attribute.name).toBe('relatedTo');
      expect(attribute.value).toBe(targetNote.note.noteId);
    });

    it('get_attributes - should list attributes on note', async () => {
      const note = await client.getNote(testNoteId);

      const testAttr = note.attributes.find((a) => a.name === 'testLabel');
      expect(testAttr).toBeDefined();
      expect(testAttr?.type).toBe('label');
      expect(testAttr?.value).toBe('testValue');

      // Verify inheritable attribute
      const inheritableAttr = note.attributes.find((a) => a.name === 'inheritableLabel');
      expect(inheritableAttr).toBeDefined();
      expect(inheritableAttr?.isInheritable).toBe(true);

      // Verify relation
      const relationAttr = note.attributes.find((a) => a.name === 'relatedTo');
      expect(relationAttr).toBeDefined();
      expect(relationAttr?.type).toBe('relation');
    });

    it('set_attribute - should update existing attribute', async () => {
      const updated = await client.updateAttribute(createdAttributeId, {
        value: 'updatedValue',
      });

      expect(updated.value).toBe('updatedValue');
    });

    it('get_attribute - should get attribute by ID', async () => {
      const attribute = await client.getAttribute(inheritableAttributeId);

      expect(attribute.attributeId).toBe(inheritableAttributeId);
      expect(attribute.name).toBe('inheritableLabel');
      expect(attribute.isInheritable).toBe(true);
    });

    it('set_attribute - should create attribute with position', async () => {
      const attribute = await client.createAttribute({
        noteId: testNoteId,
        type: 'label',
        name: 'orderedLabel',
        value: 'first',
        position: 5,
      });

      expect(attribute.position).toBe(5);
    });

    it('delete_attribute - should remove attribute', async () => {
      await client.deleteAttribute(createdAttributeId);

      const note = await client.getNote(testNoteId);
      const deletedAttr = note.attributes.find((a) => a.attributeId === createdAttributeId);
      expect(deletedAttr).toBeUndefined();
    });
  });

  describe('Calendar', () => {
    it("get_day_note - should get or create today's daily note", async () => {
      const today = new Date().toISOString().split('T')[0];
      const dayNote = await client.getDayNote(today);

      expect(dayNote).toBeDefined();
      expect(dayNote.noteId).toBeDefined();
      expect(dayNote.type).toBe('text');
    });

    it('get_day_note - should get specific date note', async () => {
      const date = '2024-06-15';
      const dayNote = await client.getDayNote(date);

      expect(dayNote).toBeDefined();
      expect(dayNote.noteId).toBeDefined();
    });

    it('get_inbox_note - should get inbox note', async () => {
      const today = new Date().toISOString().split('T')[0];
      const inboxNote = await client.getInboxNote(today);

      expect(inboxNote).toBeDefined();
      expect(inboxNote.noteId).toBeDefined();
    });

    it('get_inbox_note - should get inbox for specific date', async () => {
      const date = '2024-06-15';
      const inboxNote = await client.getInboxNote(date);

      expect(inboxNote).toBeDefined();
      expect(inboxNote.noteId).toBeDefined();
    });
  });

  describe('App Info', () => {
    it('should get application info', async () => {
      const info = await client.getAppInfo();

      expect(info).toBeDefined();
      expect(info.appVersion).toBeDefined();
      expect(info.dbVersion).toBeDefined();
      expect(typeof info.appVersion).toBe('string');
    });

    it('should have expected info properties', async () => {
      const info = await client.getAppInfo();

      expect(info.syncVersion).toBeDefined();
      expect(info.buildDate).toBeDefined();
      expect(info.dataDirectory).toBeDefined();
    });
  });

  describe('System Operations', () => {
    it('create_revision - should create a revision snapshot', async () => {
      // Create a note to revision
      const note = await client.createNote({
        parentNoteId: 'root',
        title: 'Note for Revision',
        type: 'text',
        content: '<p>Original content</p>',
      });

      // Create a revision - should not throw
      await client.createRevision(note.note.noteId, 'html');
    });

    it('create_backup - should create a database backup', async () => {
      const backupName = `test-${Date.now()}`;
      await client.createBackup(backupName);
      // Should not throw - backup was created
    });

    it('export_note - should export note as ZIP', async () => {
      // Create a note to export
      const note = await client.createNote({
        parentNoteId: 'root',
        title: 'Note to Export',
        type: 'text',
        content: '<p>Export me!</p>',
      });

      const data = await client.exportNote(note.note.noteId, 'html');

      expect(data).toBeInstanceOf(ArrayBuffer);
      expect(data.byteLength).toBeGreaterThan(0);

      // Check ZIP magic bytes
      const bytes = new Uint8Array(data);
      expect(bytes[0]).toBe(0x50); // P
      expect(bytes[1]).toBe(0x4b); // K
    });

    it('export_note - should export as markdown format', async () => {
      const note = await client.createNote({
        parentNoteId: 'root',
        title: 'Markdown Export Note',
        type: 'text',
        content: '<p>Export as markdown</p>',
      });

      const data = await client.exportNote(note.note.noteId, 'markdown');

      expect(data).toBeInstanceOf(ArrayBuffer);
      expect(data.byteLength).toBeGreaterThan(0);
    });
  });

  describe('Attachments', () => {
    let testNoteId: string;
    let createdAttachmentId: string;

    beforeAll(async () => {
      // Create a note to attach files to
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Attachment Test Note',
        type: 'text',
        content: '<p>Testing attachments</p>',
      });
      testNoteId = result.note.noteId;
    });

    it('create_attachment - should create a text attachment', async () => {
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'file',
        mime: 'text/plain',
        title: 'test-file.txt',
        content: 'Hello, this is a test file content!',
      });

      expect(attachment.ownerId).toBe(testNoteId);
      expect(attachment.role).toBe('file');
      expect(attachment.mime).toBe('text/plain');
      expect(attachment.title).toBe('test-file.txt');
      expect(attachment.attachmentId).toBeDefined();

      createdAttachmentId = attachment.attachmentId;
    });

    it('create_attachment - should create attachment with position', async () => {
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'file',
        mime: 'application/json',
        title: 'config.json',
        content: '{"key": "value"}',
        position: 100,
      });

      expect(attachment.position).toBe(100);
      expect(attachment.mime).toBe('application/json');
    });

    it('create_attachment - should create image attachment', async () => {
      // Create a simple base64-encoded 1x1 PNG pixel
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'image',
        mime: 'image/png',
        title: 'test-image.png',
        content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      });

      expect(attachment.role).toBe('image');
      expect(attachment.mime).toBe('image/png');
      expect(attachment.title).toBe('test-image.png');
    });

    it('get_attachment - should retrieve attachment metadata', async () => {
      const attachment = await client.getAttachment(createdAttachmentId);

      expect(attachment.attachmentId).toBe(createdAttachmentId);
      expect(attachment.ownerId).toBe(testNoteId);
      expect(attachment.title).toBe('test-file.txt');
      expect(attachment.mime).toBe('text/plain');
    });

    it('get_attachment_content - should retrieve attachment content', async () => {
      const content = await client.getAttachmentContent(createdAttachmentId);

      expect(content).toBe('Hello, this is a test file content!');
    });

    it('update_attachment - should update attachment title', async () => {
      const updated = await client.updateAttachment(createdAttachmentId, {
        title: 'renamed-file.txt',
      });

      expect(updated.title).toBe('renamed-file.txt');
      expect(updated.attachmentId).toBe(createdAttachmentId);
    });

    it('update_attachment - should update attachment mime type', async () => {
      const updated = await client.updateAttachment(createdAttachmentId, {
        mime: 'text/markdown',
      });

      expect(updated.mime).toBe('text/markdown');
    });

    it('update_attachment - should update attachment role', async () => {
      const updated = await client.updateAttachment(createdAttachmentId, {
        role: 'document',
      });

      expect(updated.role).toBe('document');
    });

    it('update_attachment - should update attachment position', async () => {
      const updated = await client.updateAttachment(createdAttachmentId, {
        position: 50,
      });

      expect(updated.position).toBe(50);
    });

    it('update_attachment_content - should update attachment content', async () => {
      await client.updateAttachmentContent(createdAttachmentId, 'Updated content here!');

      const content = await client.getAttachmentContent(createdAttachmentId);
      expect(content).toBe('Updated content here!');
    });

    it('update_attachment_content - should handle large content', async () => {
      const largeContent = 'Lorem ipsum dolor sit amet. '.repeat(1000);
      await client.updateAttachmentContent(createdAttachmentId, largeContent);

      const content = await client.getAttachmentContent(createdAttachmentId);
      expect(content).toBe(largeContent);
    });

    it('delete_attachment - should delete the attachment', async () => {
      // Create an attachment specifically for deletion
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'file',
        mime: 'text/plain',
        title: 'to-delete.txt',
        content: 'This will be deleted',
      });

      await client.deleteAttachment(attachment.attachmentId);

      // Verify attachment is deleted (should throw)
      await expect(client.getAttachment(attachment.attachmentId)).rejects.toThrow();
    });

    it('should handle deleting non-existent attachment gracefully', async () => {
      // Trilium's ETAPI returns success for idempotent DELETE operations
      await expect(client.deleteAttachment('nonexistent123')).resolves.not.toThrow();
    });

    it('should throw error for non-existent attachment', async () => {
      await expect(client.getAttachment('nonexistent123')).rejects.toThrow();
    });
  });

  describe('get_note_content with image attachments', () => {
    it('should return image content blocks for note with image attachment', async () => {
      // Create a note
      const noteResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note With Image Attachment',
        type: 'text',
        content: '<p>Note with an attached image</p>',
      });
      const noteId = noteResult.note.noteId;

      // Attach a 1x1 PNG pixel
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await client.createAttachment({
        ownerId: noteId,
        role: 'image',
        mime: 'image/png',
        title: 'pixel.png',
        content: pngBase64,
      });

      // Call handleNoteTool with includeImages (default true)
      const result = await handleNoteTool(client, 'get_note_content', { noteId });

      expect(result).not.toBeNull();
      // Should have text block + image block
      expect(result!.content.length).toBeGreaterThanOrEqual(2);
      expect(result!.content[0]).toEqual({
        type: 'text',
        text: expect.stringContaining('Note with an attached image'),
      });

      const imageBlock = result!.content.find((b) => b.type === 'image') as {
        type: 'image';
        data: string;
        mimeType: string;
      };
      expect(imageBlock).toBeDefined();
      expect(imageBlock.mimeType).toBe('image/png');
      expect(imageBlock.data).toBe(pngBase64);
    });

    it('should list non-image attachments in text output', async () => {
      const noteResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note With PDF Attachment',
        type: 'text',
        content: '<p>Note with a PDF</p>',
      });
      const noteId = noteResult.note.noteId;

      await client.createAttachment({
        ownerId: noteId,
        role: 'file',
        mime: 'application/pdf',
        title: 'report.pdf',
        content: 'fake-pdf-content',
      });

      const result = await handleNoteTool(client, 'get_note_content', { noteId });

      expect(result).not.toBeNull();
      // Only text block, no image block
      expect(result!.content).toHaveLength(1);
      const text = (result!.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('report.pdf');
      expect(text).toContain('application/pdf');
      expect(text).toContain('get_attachment_content');
    });

    it('should skip attachment discovery when includeImages is false', async () => {
      const noteResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note With Opt-Out',
        type: 'text',
        content: '<p>Opt out of images</p>',
      });
      const noteId = noteResult.note.noteId;

      await client.createAttachment({
        ownerId: noteId,
        role: 'image',
        mime: 'image/png',
        title: 'ignored.png',
        content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      });

      const result = await handleNoteTool(client, 'get_note_content', {
        noteId,
        includeImages: false,
      });

      expect(result).not.toBeNull();
      expect(result!.content).toHaveLength(1);
      expect(result!.content[0]).toEqual({
        type: 'text',
        text: '<p>Opt out of images</p>',
      });
    });
  });

  describe('Enhanced create_note', () => {
    it('should create note with notePosition', async () => {
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Positioned Note',
        type: 'text',
        content: '<p>At specific position</p>',
        notePosition: 5,
      });

      expect(result.branch.notePosition).toBeDefined();
    });

    it('should create note with prefix', async () => {
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Prefixed Note',
        type: 'text',
        content: '<p>With prefix</p>',
        prefix: 'Draft',
      });

      expect(result.branch.prefix).toBe('Draft');
    });

    it('should create note with isExpanded', async () => {
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Expanded Folder',
        type: 'text',
        content: '<p>Folder that starts expanded</p>',
        isExpanded: true,
      });

      expect(result.branch.isExpanded).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for non-existent note', async () => {
      await expect(client.getNote('nonexistent123')).rejects.toThrow();
    });

    it('should throw error for invalid parent note', async () => {
      await expect(
        client.createNote({
          parentNoteId: 'nonexistent123',
          title: 'Test',
          type: 'text',
          content: 'content',
        })
      ).rejects.toThrow();
    });

    it('should handle deleting non-existent note gracefully', async () => {
      // Trilium's ETAPI returns success for idempotent DELETE operations
      await expect(client.deleteNote('nonexistent123')).resolves.not.toThrow();
    });

    it('should throw error for non-existent branch', async () => {
      await expect(client.getBranch('nonexistent123')).rejects.toThrow();
    });

    it('should handle deleting non-existent attribute gracefully', async () => {
      // Trilium's ETAPI returns success for idempotent DELETE operations
      await expect(client.deleteAttribute('nonexistent123')).resolves.not.toThrow();
    });
  });

  describe('Markdown Content Support', () => {
    it('create_note - should convert markdown to HTML when format is markdown', async () => {
      const markdownContent = `# Hello World

This is a **bold** text and this is *italic*.

- Item 1
- Item 2
- Item 3

\`\`\`javascript
console.log("Hello");
\`\`\`
`;

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Markdown Test Note',
        type: 'text',
        content: markdownContent,
        format: 'markdown',
      });

      expect(result).not.toBeNull();
      const text = result!.content[0].text;
      expect(text).toContain('Note created successfully');
      const noteId = text.match(/noteId: (\S+),/)![1];

      // Verify the content was converted to HTML
      const content = await client.getNoteContent(noteId);
      expect(content).toContain('<h1>Hello World</h1>');
      expect(content).toContain('<strong>bold</strong>');
      expect(content).toContain('<em>italic</em>');
      expect(content).toContain('<li>Item 1</li>');
      expect(content).toContain('<li>Item 2</li>');
      expect(content).toContain('<code');
    });

    it('create_note - should pass HTML unchanged when format is html', async () => {
      const htmlContent = '<div class="custom"><p>Already HTML</p></div>';

      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'HTML Format Test Note',
        type: 'text',
        content: htmlContent,
      });

      const content = await client.getNoteContent(createResult.note.noteId);
      expect(content).toBe(htmlContent);
    });

    it('create_note - should pass content unchanged when format is not specified (default)', async () => {
      const htmlContent = '<p>Default behavior is HTML</p>';

      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Default Format Test Note',
        type: 'text',
        content: htmlContent,
      });

      const content = await client.getNoteContent(createResult.note.noteId);
      expect(content).toBe(htmlContent);
    });

    it('update_note_content - should convert markdown to HTML when format is markdown', async () => {
      // Create a note first
      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note for Markdown Update',
        type: 'text',
        content: '<p>Initial content</p>',
      });

      const markdownUpdate = `## Updated Heading

Here is a [link](https://example.com) and some \`inline code\`.

1. First item
2. Second item
`;

      await handleNoteTool(client, 'update_note_content', {
        noteId: createResult.note.noteId,
        content: markdownUpdate,
        format: 'markdown',
      });

      const content = await client.getNoteContent(createResult.note.noteId);
      expect(content).toContain('<h2>Updated Heading</h2>');
      expect(content).toContain('<a href="https://example.com">link</a>');
      expect(content).toContain('<code>inline code</code>');
      expect(content).toContain('<li>First item</li>');
      expect(content).toContain('<li>Second item</li>');
    });

    it('update_note_content - should pass HTML unchanged when format is not specified', async () => {
      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note for HTML Update',
        type: 'text',
        content: '<p>Initial content</p>',
      });

      const htmlUpdate = '<article><h1>HTML Update</h1><p>Unchanged</p></article>';

      await handleNoteTool(client, 'update_note_content', {
        noteId: createResult.note.noteId,
        content: htmlUpdate,
      });

      const content = await client.getNoteContent(createResult.note.noteId);
      expect(content).toBe(htmlUpdate);
    });

    it('create_note - should handle complex markdown with tables', async () => {
      const markdownWithTable = `# Data Table

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| A1       | B1       | C1       |
| A2       | B2       | C2       |

> This is a blockquote
`;

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Table Markdown Note',
        type: 'text',
        content: markdownWithTable,
        format: 'markdown',
      });

      expect(result).not.toBeNull();
      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const content = await client.getNoteContent(noteId);
      expect(content).toContain('<h1>Data Table</h1>');
      expect(content).toContain('<table>');
      expect(content).toContain('<th>Column 1</th>');
      expect(content).toContain('<td>A1</td>');
      expect(content).toContain('<blockquote>');
    });

    it('create_note - should handle markdown with special characters', async () => {
      const markdownWithSpecialChars = `# Special Characters Test

This has <angle brackets> and "quotes" & ampersands.

\`\`\`html
<div class="test">HTML in code block</div>
\`\`\`
`;

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Special Characters Markdown Note',
        type: 'text',
        content: markdownWithSpecialChars,
        format: 'markdown',
      });

      expect(result).not.toBeNull();
      const text = result!.content[0].text;
      expect(text).toContain('Note created successfully');
      const noteId = text.match(/noteId: (\S+),/)![1];

      // Content was successfully stored
      const content = await client.getNoteContent(noteId);
      expect(content).toContain('<h1>Special Characters Test</h1>');
    });

    it('create_note - should handle empty markdown', async () => {
      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Empty Markdown Note',
        type: 'text',
        content: '',
      });

      const content = await client.getNoteContent(createResult.note.noteId);
      expect(content).toBe('');
    });
  });

  describe('Image Embedding via handleNoteTool', () => {
    // A minimal 1x1 PNG pixel encoded as base64
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    it('create_note with images - should create note, create attachment, and resolve placeholders', async () => {
      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Note With Embedded Image',
        type: 'text',
        content: '<p>Here is an image:</p><img src="image:0">',
        images: [{ data: pngBase64, mime: 'image/png', filename: 'pixel.png' }],
      });

      expect(result).not.toBeNull();
      const text = result!.content[0].text;
      expect(text).toContain('Note created successfully');
      const noteId = text.match(/noteId: (\S+),/)![1];

      // Verify the content has resolved attachment URL (not placeholder)
      const content = await client.getNoteContent(noteId);
      expect(content).not.toContain('image:0');
      expect(content).toContain('api/attachments/');
      expect(content).toContain('/image/pixel.png');
      expect(content).toContain('<p>Here is an image:</p>');

      // Verify the attachment was created
      const attachments = await client.getNoteAttachments(noteId);
      expect(attachments.length).toBe(1);
      expect(attachments[0].role).toBe('image');
      expect(attachments[0].mime).toBe('image/png');
      expect(attachments[0].title).toBe('pixel.png');
    });

    it('create_note with images - unreferenced images should be appended', async () => {
      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Note With Appended Image',
        type: 'text',
        content: '<p>No placeholder here</p>',
        images: [{ data: pngBase64, mime: 'image/png', filename: 'appended.png' }],
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const content = await client.getNoteContent(noteId);
      expect(content).toContain('<p>No placeholder here</p>');
      expect(content).toContain('api/attachments/');
      expect(content).toContain('/image/appended.png');
    });

    it('create_note with images - multiple images with placeholders', async () => {
      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Note With Multiple Images',
        type: 'text',
        content: '<img src="image:0"><p>Between</p><img src="image:1">',
        images: [
          { data: pngBase64, mime: 'image/png', filename: 'first.png' },
          { data: pngBase64, mime: 'image/jpeg', filename: 'second.jpg' },
        ],
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const content = await client.getNoteContent(noteId);
      expect(content).not.toContain('image:0');
      expect(content).not.toContain('image:1');
      expect(content).toContain('/image/first.png');
      expect(content).toContain('/image/second.jpg');
      expect(content).toContain('<p>Between</p>');

      const attachments = await client.getNoteAttachments(noteId);
      expect(attachments.length).toBe(2);
    });

    it('create_note with markdown and images - should convert markdown then resolve placeholders', async () => {
      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Markdown With Image',
        type: 'text',
        content: '# Hello\n\n![my photo](image:0)\n\nSome text.',
        format: 'markdown',
        images: [{ data: pngBase64, mime: 'image/png', filename: 'photo.png' }],
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const content = await client.getNoteContent(noteId);
      expect(content).toContain('<h1>Hello</h1>');
      expect(content).not.toContain('image:0');
      expect(content).toContain('api/attachments/');
      expect(content).toContain('/image/photo.png');
    });

    it('create_note without images - should not create attachments (backward compat)', async () => {
      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'No Images Note',
        type: 'text',
        content: '<p>Just text</p>',
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const content = await client.getNoteContent(noteId);
      expect(content).toBe('<p>Just text</p>');

      const attachments = await client.getNoteAttachments(noteId);
      expect(attachments.length).toBe(0);
    });

    it('update_note_content with images - should create attachment and resolve placeholders', async () => {
      // Create note first
      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note for Image Update',
        type: 'text',
        content: '<p>Initial content</p>',
      });
      const noteId = createResult.note.noteId;

      await handleNoteTool(client, 'update_note_content', {
        noteId,
        content: '<p>Updated with image</p><img src="image:0">',
        images: [{ data: pngBase64, mime: 'image/png', filename: 'updated.png' }],
      });

      const content = await client.getNoteContent(noteId);
      expect(content).not.toContain('image:0');
      expect(content).toContain('api/attachments/');
      expect(content).toContain('/image/updated.png');
      expect(content).toContain('<p>Updated with image</p>');
    });

    it('append_note_content with images - should append content and create attachment', async () => {
      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note for Image Append',
        type: 'text',
        content: '<p>Original content</p>',
      });
      const noteId = createResult.note.noteId;

      await handleNoteTool(client, 'append_note_content', {
        noteId,
        content: '<p>Appended section</p><img src="image:0">',
        images: [{ data: pngBase64, mime: 'image/png', filename: 'appended.png' }],
      });

      const content = await client.getNoteContent(noteId);
      expect(content).toContain('<p>Original content</p>');
      expect(content).toContain('<p>Appended section</p>');
      expect(content).not.toContain('image:0');
      expect(content).toContain('api/attachments/');
      expect(content).toContain('/image/appended.png');
    });
  });

  describe('File Embedding via handleNoteTool', () => {
    const fakeFileBase64 = btoa('Hello, this is a test file!');

    it('create_note with files - should create note, create file attachment, and resolve placeholders', async () => {
      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Note With Embedded File',
        type: 'text',
        content: '<p>Download: <a href="file:0">Report</a></p>',
        files: [{ data: fakeFileBase64, mime: 'application/pdf', filename: 'report.pdf' }],
      });

      expect(result).not.toBeNull();
      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      // Verify the content has resolved attachment URL (not placeholder)
      const content = await client.getNoteContent(noteId);
      expect(content).not.toContain('file:0');
      expect(content).toContain('api/attachments/');
      expect(content).toContain('/download');
      expect(content).toContain('>Report</a>');

      // Verify the attachment was created with role "file"
      const attachments = await client.getNoteAttachments(noteId);
      expect(attachments.length).toBe(1);
      expect(attachments[0].role).toBe('file');
      expect(attachments[0].mime).toBe('application/pdf');
      expect(attachments[0].title).toBe('report.pdf');
    });

    it('create_note with files - unreferenced files should be appended as download links', async () => {
      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Note With Appended File',
        type: 'text',
        content: '<p>No file placeholder here</p>',
        files: [{ data: fakeFileBase64, mime: 'text/csv', filename: 'data.csv' }],
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const content = await client.getNoteContent(noteId);
      expect(content).toContain('<p>No file placeholder here</p>');
      expect(content).toContain('/download');
      expect(content).toContain('>data.csv</a>');
    });

    it('create_note with both images and files', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Note With Image and File',
        type: 'text',
        content: '<img src="image:0"><p>And a file: <a href="file:0">Download</a></p>',
        images: [{ data: pngBase64, mime: 'image/png', filename: 'photo.png' }],
        files: [{ data: fakeFileBase64, mime: 'application/pdf', filename: 'doc.pdf' }],
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const content = await client.getNoteContent(noteId);
      expect(content).not.toContain('image:0');
      expect(content).not.toContain('file:0');
      expect(content).toContain('/image/photo.png');
      expect(content).toContain('/download');
      expect(content).toContain('>Download</a>');

      const attachments = await client.getNoteAttachments(noteId);
      expect(attachments.length).toBe(2);
      expect(attachments.some((a) => a.role === 'image')).toBe(true);
      expect(attachments.some((a) => a.role === 'file')).toBe(true);
    });

    it('update_note_content with files - should create file attachment and resolve placeholders', async () => {
      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note for File Update',
        type: 'text',
        content: '<p>Initial content</p>',
      });

      await handleNoteTool(client, 'update_note_content', {
        noteId: createResult.note.noteId,
        content: '<p>Updated with file: <a href="file:0">Data</a></p>',
        files: [{ data: fakeFileBase64, mime: 'text/csv', filename: 'data.csv' }],
      });

      const content = await client.getNoteContent(createResult.note.noteId);
      expect(content).not.toContain('file:0');
      expect(content).toContain('/download');
      expect(content).toContain('>Data</a>');
    });

    it('append_note_content with files - should append and create file attachment', async () => {
      const createResult = await client.createNote({
        parentNoteId: 'root',
        title: 'Note for File Append',
        type: 'text',
        content: '<p>Original content</p>',
      });

      await handleNoteTool(client, 'append_note_content', {
        noteId: createResult.note.noteId,
        content: '<p>Appended: <a href="file:0">Attachment</a></p>',
        files: [{ data: fakeFileBase64, mime: 'application/pdf', filename: 'attachment.pdf' }],
      });

      const content = await client.getNoteContent(createResult.note.noteId);
      expect(content).toContain('<p>Original content</p>');
      expect(content).toContain('/download');
      expect(content).toContain('>Attachment</a>');
    });
  });

  describe('Data URL Support', () => {
    it('create_note with image data URL - should extract mime and base64 from data URL', async () => {
      // 1x1 PNG as a data URL
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const dataUrl = `data:image/png;base64,${pngBase64}`;

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Data URL Image Test',
        type: 'text',
        content: '<img src="image:0">',
        images: [{
          data: dataUrl,
          mime: 'text/plain',  // should be overridden by data URL
          filename: 'from-data-url.png',
        }],
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      // Verify the attachment was created with the correct mime from the data URL
      const attachments = await client.getNoteAttachments(noteId);
      expect(attachments.length).toBe(1);
      expect(attachments[0].mime).toBe('image/png');  // from data URL, not 'text/plain'
      expect(attachments[0].title).toBe('from-data-url.png');

      // Verify content was resolved
      const content = await client.getNoteContent(noteId);
      expect(content).not.toContain('image:0');
      expect(content).toContain('api/attachments/');
    });

    it('create_note with file data URL - should extract mime and base64', async () => {
      const csvContent = btoa('name,value\nfoo,1\nbar,2');
      const dataUrl = `data:text/csv;base64,${csvContent}`;

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Data URL File Test',
        type: 'text',
        content: '<a href="file:0">CSV Data</a>',
        files: [{
          data: dataUrl,
          mime: 'application/octet-stream',  // should be overridden
          filename: 'data.csv',
        }],
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const attachments = await client.getNoteAttachments(noteId);
      expect(attachments.length).toBe(1);
      expect(attachments[0].mime).toBe('text/csv');  // from data URL
      expect(attachments[0].title).toBe('data.csv');
    });

    it('raw base64 should still work with explicit mime', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      const result = await handleNoteTool(client, 'create_note', {
        parentNoteId: 'root',
        title: 'Raw Base64 Test',
        type: 'text',
        content: '<img src="image:0">',
        images: [{
          data: pngBase64,  // raw base64, not a data URL
          mime: 'image/png',
          filename: 'raw.png',
        }],
      });

      const text = result!.content[0].text;
      const noteId = text.match(/noteId: (\S+),/)![1];

      const attachments = await client.getNoteAttachments(noteId);
      expect(attachments.length).toBe(1);
      expect(attachments[0].mime).toBe('image/png');
    });
  });

  describe('Attachment Inline Viewing and Download', () => {
    let testNoteId: string;

    beforeAll(async () => {
      const result = await client.createNote({
        parentNoteId: 'root',
        title: 'Attachment Access Test Note',
        type: 'text',
        content: '<p>Testing attachment access</p>',
      });
      testNoteId = result.note.noteId;
    });

    it('image attachment should be accessible via /image/{title} endpoint', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'image',
        mime: 'image/png',
        title: 'test-image.png',
        content: pngBase64,
      });

      // Access via /image/{title} (the URL format used in note HTML)
      const baseUrl = (client as any).baseUrl.replace('/etapi', '');
      const resp = await fetch(
        `${baseUrl}/api/attachments/${attachment.attachmentId}/image/test-image.png`
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('image/png');
    });

    it('image attachment should be accessible via /open endpoint for inline viewing', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'image',
        mime: 'image/png',
        title: 'inline-image.png',
        content: pngBase64,
      });

      const baseUrl = (client as any).baseUrl.replace('/etapi', '');
      const resp = await fetch(
        `${baseUrl}/api/attachments/${attachment.attachmentId}/open`
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('image/png');
    });

    it('file attachment should be accessible via /open endpoint for inline viewing', async () => {
      const fileContent = btoa('Test file content for inline viewing');
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'file',
        mime: 'application/pdf',
        title: 'inline-doc.pdf',
        content: fileContent,
      });

      const baseUrl = (client as any).baseUrl.replace('/etapi', '');
      const resp = await fetch(
        `${baseUrl}/api/attachments/${attachment.attachmentId}/open`
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('application/pdf');
    });

    it('file attachment should be downloadable via /download endpoint', async () => {
      const fileContent = btoa('Downloadable file content');
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'file',
        mime: 'application/pdf',
        title: 'download-doc.pdf',
        content: fileContent,
      });

      const baseUrl = (client as any).baseUrl.replace('/etapi', '');
      const resp = await fetch(
        `${baseUrl}/api/attachments/${attachment.attachmentId}/download`
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('application/pdf');
      const contentDisposition = resp.headers.get('content-disposition') || '';
      expect(contentDisposition).toContain('file');
      expect(contentDisposition).toContain('download-doc.pdf');
    });

    it('file attachment /image/ endpoint should return error (not an image)', async () => {
      const fileContent = btoa('Not an image');
      const attachment = await client.createAttachment({
        ownerId: testNoteId,
        role: 'file',
        mime: 'application/pdf',
        title: 'not-image.pdf',
        content: fileContent,
      });

      const baseUrl = (client as any).baseUrl.replace('/etapi', '');
      const resp = await fetch(
        `${baseUrl}/api/attachments/${attachment.attachmentId}/image/not-image.pdf`
      );
      // Should not be 200 (file is not an image)
      expect(resp.status).not.toBe(200);
    });
  });
});
