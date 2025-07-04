import { create } from 'zustand';
import {
  Node,
  Edge,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
  NodeChange,
  EdgeChange,
} from '@xyflow/react';
import { nanoid } from 'nanoid';
import { ChatManager } from '../utils/chatManager';
import logger from '../utils/logger';
import { persistentStorage, STORAGE_VERSION } from '../utils/persistentStorage';
import { debouncedSave, isSaving } from '../utils/saveDebouncer';
import { workspaceManager, WorkspaceMetadata } from '../utils/workspaceManager';

export interface AttachmentData {
  name: string;
  type: string;
  data: string; // base64
  previewUrl: string; // object URL for client-side display
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  attachments?: AttachmentData[];
  modelId?: string; // Track which model generated this response
}

export type CustomNodeData = {
  label: string;
  chatHistory: ChatMessage[];
};

// Session storage interface
interface SessionData {
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
  activeNodeId: string | null;
  timestamp: number;
  version: string;
}

interface ChatState {
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
  chatManager: ChatManager | null;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  addMessageToNode: (nodeId: string, message: ChatMessage, isPartial?: boolean) => void;
  removeLastMessageFromNode: (nodeId: string) => void;
  updateLastMessageInNode: (nodeId: string, content: string, modelId?: string) => void;
  createNodeAndEdge: (sourceNodeId: string, label: string, type: 'response' | 'branch') => string; // Return new nodeId
  getPathToNode: (targetNodeId: string) => ChatMessage[];
  getPathNodeIds: (targetNodeId: string) => string[];
  getPathEdgeIds: (targetNodeId: string) => string[];
  resetNode: (nodeId: string) => void;
  deleteNodeAndDescendants: (nodeId: string) => void;
  activeNodeId: string | null;
  activePath: {
    nodeIds: string[];
    edgeIds: string[];
  };
  setActiveNodeId: (nodeId: string | null) => void;
  initializeChatManager: (apiKey: string) => void;
  sendMessageToNode: (nodeId: string, message: string) => Promise<void>;
  // Enhanced storage methods
  saveToStorage: () => boolean;
  loadFromStorage: () => boolean;
  clearStorage: () => void;
  exportWorkspace: () => string | null;
  importWorkspace: (data: string) => boolean;
  getStorageStats: () => any;
  // Legacy session methods (for backward compatibility)
  saveToSession: () => void;
  loadFromSession: () => boolean;
  clearSession: () => void;
  copyToClipboard: (content: string) => Promise<void>;
  // Storage consent methods
  hasStorageConsent: () => boolean;
  needsStorageConsent: () => boolean;
  setStorageConsent: (granted: boolean) => void;
  // Workspace management methods
  getCurrentWorkspace: () => WorkspaceMetadata | null;
  switchWorkspace: (workspaceId: string) => boolean;
  createNewWorkspace: (name: string) => string;
  renameCurrentWorkspace: (newName: string) => boolean;
  deleteWorkspace: (workspaceId: string) => boolean;
}

const ROOT_NODE: Node<CustomNodeData> = {
  id: 'root',
  type: 'chatNode',
  data: { label: 'Start your conversation', chatHistory: [] },
  position: { x: 250, y: 50 },
};

// Legacy keys for backward compatibility
const SESSION_STORAGE_KEY = 'aether-chat-session';
const LEGACY_SESSION_VERSION = '1.0.0';
const SESSION_VERSION = '1.0.0';

// Utility functions for session management
const saveSessionData = (data: SessionData): boolean => {
  try {
    const serialized = JSON.stringify(data);
    
    // Check if data is too large (Chrome limit is ~5MB)
    if (serialized.length > 4.5 * 1024 * 1024) { // 4.5MB to be safe
      logger.warn('ChatStore: Session data too large, attempting to compress');
      
      // Try to save a compressed version with only essential data
      const compressedData: SessionData = {
        ...data,
        nodes: data.nodes.map(node => ({
          ...node,
          data: {
            ...node.data,
            // Truncate very long messages to save space
            chatHistory: node.data.chatHistory.map(msg => ({
              ...msg,
              content: msg.content.length > 10000 ? msg.content.substring(0, 10000) + '...[truncated]' : msg.content,
              // Remove large attachments from session storage
              attachments: msg.attachments?.filter(att => att.data.length < 100000) || []
            }))
          }
        }))
      };
      
      const compressedSerialized = JSON.stringify(compressedData);
      if (compressedSerialized.length > 4.5 * 1024 * 1024) {
        logger.error('ChatStore: Even compressed session data is too large');
        return false;
      }
      
      sessionStorage.setItem(SESSION_STORAGE_KEY, compressedSerialized);
      logger.info('ChatStore: Session saved with compression');
      return true;
    }
    
    sessionStorage.setItem(SESSION_STORAGE_KEY, serialized);
    logger.debug('ChatStore: Session saved successfully', { 
      dataSize: serialized.length,
      nodeCount: data.nodes.length,
      edgeCount: data.edges.length
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'QuotaExceededError') {
      logger.error('ChatStore: Session storage quota exceeded');
      // Try to clear old data and save again
      try {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        const retryData = JSON.stringify(data);
        if (retryData.length <= 4.5 * 1024 * 1024) {
          sessionStorage.setItem(SESSION_STORAGE_KEY, retryData);
          logger.info('ChatStore: Session saved after clearing old data');
          return true;
        }
      } catch (retryError) {
        logger.error('ChatStore: Failed to save session even after clearing old data', { error: retryError });
      }
    } else {
      logger.error('ChatStore: Failed to save session', { error });
    }
    return false;
  }
};

const loadSessionData = (): SessionData | null => {
  try {
    const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!stored) {
      logger.debug('ChatStore: No session data found');
      return null;
    }
    
    const data: SessionData = JSON.parse(stored);
    
    // Validate session data
    if (!data.nodes || !Array.isArray(data.nodes) || !data.edges || !Array.isArray(data.edges)) {
      logger.warn('ChatStore: Invalid session data structure');
      return null;
    }
    
    // Check version compatibility
    if (data.version !== SESSION_VERSION) {
      logger.warn('ChatStore: Session version mismatch', { 
        stored: data.version, 
        current: SESSION_VERSION 
      });
      // For now, we'll still load it, but in future versions we might want to migrate
    }
    
    logger.info('ChatStore: Session data loaded successfully', {
      nodeCount: data.nodes.length,
      edgeCount: data.edges.length,
      activeNodeId: data.activeNodeId,
      timestamp: new Date(data.timestamp).toISOString()
    });
    
    return data;
  } catch (error) {
    logger.error('ChatStore: Failed to load session data', { error });
    return null;
  }
};

export const useChatStore = create<ChatState>((set, get) => ({
  nodes: [ROOT_NODE],
  edges: [],
  chatManager: null,
  activeNodeId: 'root', // Set root as initial active node
  activePath: {
    nodeIds: ['root'],
    edgeIds: []
  },

  // Enhanced storage methods
  saveToStorage: () => {
    // Use the debouncer utility to prevent infinite loops
    debouncedSave('workspace', () => {
      const state = get();
      const currentWorkspaceId = workspaceManager.getActiveWorkspaceId();
      const currentWorkspace = workspaceManager.getActiveWorkspace();
      
      const workspaceData = {
        name: currentWorkspace?.name || 'Current Workspace',
        nodes: state.nodes,
        edges: state.edges,
        activeNodeId: state.activeNodeId,
        timestamp: Date.now(),
        version: STORAGE_VERSION,
        metadata: {
          totalMessages: state.nodes.reduce((sum, node) => 
            sum + (node.data?.chatHistory?.length || 0), 0
          ),
          totalAttachments: state.nodes.reduce((sum, node) => 
            sum + (node.data?.chatHistory?.reduce((msgSum: number, msg: any) => 
              msgSum + (msg.attachments?.length || 0), 0) || 0), 0
          ),
          createdAt: currentWorkspace?.createdAt || Date.now(),
          lastModified: Date.now(),
          dataSize: 0
        }
      };
      
      const success = workspaceManager.saveWorkspaceData(currentWorkspaceId, workspaceData);
      
      if (success) {
        logger.debug('ChatStore: Workspace saved successfully using workspace manager');
      } else {
        logger.warn('ChatStore: Failed to save workspace using workspace manager');
      }
      
      return success;
    }, 200).catch(error => {
      logger.error('ChatStore: Error during debounced save', { error });
    });

    return !isSaving('workspace'); // Return false if already saving
  },

  loadFromStorage: () => {
    try {
      const currentWorkspaceId = workspaceManager.getActiveWorkspaceId();
      const workspaceData = workspaceManager.getWorkspaceData(currentWorkspaceId);
      if (!workspaceData) {
        logger.debug('ChatStore: No workspace data found for current workspace');
        return false;
      }

      // Ensure root node exists
      const hasRoot = workspaceData.nodes.some(node => node.id === 'root');
      if (!hasRoot) {
        workspaceData.nodes.unshift(ROOT_NODE);
        logger.debug('ChatStore: Added missing root node to workspace data');
      }

      set((state) => {
        // Calculate active path after setting the new data
        const getPathNodeIds = (targetNodeId: string): string[] => {
          const path: string[] = [];
          let currentId: string | undefined = targetNodeId;
          
          const incoming = new Map<string, string>();
          workspaceData.edges.forEach((edge) => {
            incoming.set(edge.target, edge.source);
          });
          
          while (currentId) {
            path.unshift(currentId);
            currentId = incoming.get(currentId);
            if (!currentId) break;
          }
          
          return path;
        };
        
        const getPathEdgeIds = (targetNodeId: string): string[] => {
          const nodeIds = getPathNodeIds(targetNodeId);
          const edgeIds: string[] = [];
          
          for (let i = 0; i < nodeIds.length - 1; i++) {
            const sourceId = nodeIds[i];
            const targetId = nodeIds[i + 1];
            
            const edge = workspaceData.edges.find(e => e.source === sourceId && e.target === targetId);
            if (edge) {
              edgeIds.push(edge.id);
            }
          }
          
          return edgeIds;
        };
        
        return {
          nodes: workspaceData.nodes,
          edges: workspaceData.edges,
          activeNodeId: workspaceData.activeNodeId,
          activePath: workspaceData.activeNodeId ? {
            nodeIds: getPathNodeIds(workspaceData.activeNodeId),
            edgeIds: getPathEdgeIds(workspaceData.activeNodeId)
          } : { nodeIds: [], edgeIds: [] }
        };
      });

      logger.info('ChatStore: Workspace restored from persistent storage', {
        nodeCount: workspaceData.nodes.length,
        edgeCount: workspaceData.edges.length,
        totalMessages: workspaceData.metadata.totalMessages,
        hasConsent: persistentStorage.hasConsent()
      });

      return true;
    } catch (error) {
      logger.error('ChatStore: Failed to load workspace from persistent storage', { error });
      return false;
    }
  },

  clearStorage: () => {
    persistentStorage.clearWorkspaceData();
    set({
      nodes: [ROOT_NODE],
      edges: [],
      activeNodeId: null,
      activePath: { nodeIds: [], edgeIds: [] }
    });
    logger.info('ChatStore: Workspace cleared from persistent storage');
  },

  exportWorkspace: () => {
    return persistentStorage.exportWorkspaceData();
  },

  importWorkspace: (data: string) => {
    const success = persistentStorage.importWorkspaceData(data);
    if (success) {
      // Reload the workspace after successful import
      get().loadFromStorage();
    }
    return success;
  },

  getStorageStats: () => {
    return persistentStorage.getStorageStats();
  },

  // Storage consent methods
  hasStorageConsent: () => {
    return persistentStorage.hasConsent();
  },

  needsStorageConsent: () => {
    return persistentStorage.needsConsent();
  },

  setStorageConsent: (granted: boolean) => {
    persistentStorage.setConsent(granted);
    logger.info('ChatStore: Storage consent updated', { granted });
    
    // If consent is granted and we have data, save it persistently
    if (granted) {
      get().saveToStorage();
    }
  },

  // Legacy session methods (for backward compatibility)
  saveToSession: () => {
    const state = get();
    const sessionData: SessionData = {
      nodes: state.nodes,
      edges: state.edges,
      activeNodeId: state.activeNodeId,
      timestamp: Date.now(),
      version: LEGACY_SESSION_VERSION
    };
    
    saveSessionData(sessionData);
  },

  loadFromSession: () => {
    const sessionData = loadSessionData();
    if (!sessionData) {
      return false;
    }
    
    // Ensure root node exists
    const hasRoot = sessionData.nodes.some(node => node.id === 'root');
    if (!hasRoot) {
      sessionData.nodes.unshift(ROOT_NODE);
      logger.debug('ChatStore: Added missing root node to session data');
    }
    
    set((state) => {
      // Calculate active path after setting the new data
      const getPathNodeIds = (targetNodeId: string): string[] => {
        const path: string[] = [];
        let currentId: string | undefined = targetNodeId;
        
        const incoming = new Map<string, string>();
        sessionData.edges.forEach((edge) => {
          incoming.set(edge.target, edge.source);
        });
        
        while (currentId) {
          path.unshift(currentId);
          currentId = incoming.get(currentId);
          if (!currentId) break;
        }
        
        return path;
      };
      
      const getPathEdgeIds = (targetNodeId: string): string[] => {
        const nodeIds = getPathNodeIds(targetNodeId);
        const edgeIds: string[] = [];
        
        for (let i = 0; i < nodeIds.length - 1; i++) {
          const sourceId = nodeIds[i];
          const targetId = nodeIds[i + 1];
          
          const edge = sessionData.edges.find(e => e.source === sourceId && e.target === targetId);
          if (edge) {
            edgeIds.push(edge.id);
          }
        }
        
        return edgeIds;
      };
      
      return {
        nodes: sessionData.nodes,
        edges: sessionData.edges,
        activeNodeId: sessionData.activeNodeId,
        activePath: sessionData.activeNodeId ? {
          nodeIds: getPathNodeIds(sessionData.activeNodeId),
          edgeIds: getPathEdgeIds(sessionData.activeNodeId)
        } : { nodeIds: [], edgeIds: [] }
      };
    });
    
    logger.info('ChatStore: Session restored successfully');
    return true;
  },

  clearSession: () => {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      logger.info('ChatStore: Session cleared');
    } catch (error) {
      logger.error('ChatStore: Failed to clear session', { error });
    }
  },

  copyToClipboard: async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      logger.debug('ChatStore: Content copied to clipboard', { 
        contentLength: content.length,
        contentPreview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
      });
    } catch (error) {
      logger.error('ChatStore: Failed to copy to clipboard', { error });
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = content;
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        logger.debug('ChatStore: Content copied to clipboard using fallback method');
      } catch (fallbackError) {
        logger.error('ChatStore: Fallback copy method also failed', { error: fallbackError });
        throw fallbackError;
      } finally {
        document.body.removeChild(textArea);
      }
    }
  },

  initializeChatManager: (apiKey: string) => {
    logger.info('ChatStore: Initializing chat manager', { 
      hasApiKey: !!apiKey,
      apiKeyLength: apiKey?.length || 0 
    });
    set({ chatManager: new ChatManager(apiKey) });
    logger.debug('ChatStore: Chat manager initialized successfully');
  },

  sendMessageToNode: async (nodeId: string, message: string) => {
    logger.info('ChatStore: Sending message to node', { 
      nodeId, 
      messageLength: message.length,
      messagePreview: message.substring(0, 100) + (message.length > 100 ? '...' : '')
    });

    const state = get();
    if (!state.chatManager) {
      logger.error('ChatStore: Chat manager not initialized', { nodeId });
      throw new Error('Chat manager not initialized');
    }

    const pathMessages = state.getPathToNode(nodeId);
    logger.debug('ChatStore: Retrieved path messages', { 
      nodeId, 
      pathLength: pathMessages.length 
    });

    // Extract attachments from the last user message (if any)
    const lastMessage = pathMessages[pathMessages.length - 1];
    const attachments = (lastMessage?.role === 'user' && lastMessage.attachments) ? lastMessage.attachments : undefined;
    
    // Get or create thread with document inheritance
    const thread = state.chatManager.getThread(nodeId, pathMessages);
    logger.debug('ChatStore: Got thread from chat manager', { 
      nodeId, 
      hasThread: !!thread,
      threadDocuments: thread?.documentContext?.length || 0,
      hasAttachments: !!attachments?.length
    });
    
    try {
      logger.debug('ChatStore: Calling chat manager sendMessage with attachments', { 
        nodeId,
        hasAttachments: !!attachments?.length,
        attachmentsCount: attachments?.length || 0
      });
      
      const response = await state.chatManager.sendMessage(nodeId, message, attachments);
      logger.info('ChatStore: Received response from chat manager', { 
        nodeId, 
        responseLength: response.length,
        responsePreview: response.substring(0, 100) + (response.length > 100 ? '...' : '')
      });

      state.addMessageToNode(nodeId, { role: 'model', content: response, modelId: 'chatManager' });
      logger.debug('ChatStore: Model response added to node', { nodeId });
      
      // Save to storage after successful message
      state.saveToStorage();
    } catch (error) {
      logger.error('ChatStore: sendMessage failed', { 
        nodeId, 
        error: error instanceof Error ? error.message : error 
      });
      state.addMessageToNode(nodeId, { 
        role: 'model', 
        content: `Error: ${error instanceof Error ? error.message : 'An unexpected error occurred'}`,
        modelId: 'error'
      });
    }
  },

  onNodesChange: (changes) => {
    logger.debug('ChatStore: Processing node changes', { 
      changeCount: changes.length,
      changeTypes: changes.map(c => c.type)
    });

    set((state) => {
      const nodesToRemove = new Set<string>();
  
      for (const change of changes) {
        if (change.type === 'remove') {
          if (change.id === 'root') {
            logger.warn('ChatStore: Attempted to remove root node - blocked', { changeId: change.id });
            continue;
          }
          nodesToRemove.add(change.id);
          logger.debug('ChatStore: Node marked for removal', { nodeId: change.id });
        }
      }
  
      if (nodesToRemove.size > 0) {
        logger.info('ChatStore: Processing node removals', { 
          nodesToRemoveCount: nodesToRemove.size,
          nodeIds: Array.from(nodesToRemove)
        });

        const descendants = new Set<string>();
        const queue = [...nodesToRemove];
  
        while (queue.length > 0) {
          const currentId = queue.shift()!;
          state.edges.forEach((edge) => {
            if (edge.source === currentId) {
              if (!descendants.has(edge.target)) {
                descendants.add(edge.target);
                queue.push(edge.target);
                logger.debug('ChatStore: Descendant node found', { 
                  parentId: currentId, 
                  descendantId: edge.target 
                });
              }
            }
          });
        }
  
        descendants.forEach((id) => nodesToRemove.add(id));
        
        logger.info('ChatStore: All descendants identified', { 
          totalNodesToRemove: nodesToRemove.size,
          descendants: Array.from(descendants)
        });
        
        // Clean up chat threads for removed nodes
        nodesToRemove.forEach(id => {
          state.chatManager?.deleteThread(id);
          logger.debug('ChatStore: Chat thread deleted', { nodeId: id });
        });
      }
  
      const remainingNodes = state.nodes.filter((node) => !nodesToRemove.has(node.id));
      const appliedChanges = applyNodeChanges(changes, remainingNodes);
      
      if (!appliedChanges.some(node => node.id === 'root')) {
        appliedChanges.push(ROOT_NODE);
        logger.debug('ChatStore: Root node restored to changes');
      }

      const newState = {
        nodes: appliedChanges as Node<CustomNodeData>[],
        edges: state.edges.filter((edge) => !nodesToRemove.has(edge.source) && !nodesToRemove.has(edge.target)),
      };

      logger.info('ChatStore: Node changes applied', { 
        previousNodeCount: state.nodes.length,
        newNodeCount: newState.nodes.length,
        previousEdgeCount: state.edges.length,
        newEdgeCount: newState.edges.length,
        removedNodes: nodesToRemove.size
      });
  
      return newState;
    });
    
    // Note: We don't save to storage here to prevent infinite loops during ReactFlow updates
    // Storage will be saved by other user actions that modify the graph
  },

  onEdgesChange: (changes) => {
    logger.debug('ChatStore: Processing edge changes', { 
      changeCount: changes.length,
      changeTypes: changes.map(c => c.type)
    });

    set((state) => {
      const newEdges = applyEdgeChanges(changes, state.edges);
      logger.debug('ChatStore: Edge changes applied', { 
        previousEdgeCount: state.edges.length,
        newEdgeCount: newEdges.length
      });

      return { edges: newEdges };
    });
  },

  resetNode: (nodeId: string) => {
    logger.info('ChatStore: Resetting node', { nodeId });

    set((state) => {
      // Find all descendant nodes
      const nodesToRemove = new Set<string>();
      const queue = [nodeId];

      while (queue.length > 0) {
        const currentId = queue.shift()!;
        state.edges.forEach((edge) => {
          if (edge.source === currentId) {
            nodesToRemove.add(edge.target);
            queue.push(edge.target);
            logger.debug('ChatStore: Descendant marked for removal', { 
              parentId: currentId, 
              descendantId: edge.target 
            });
          }
        });
      }

      logger.info('ChatStore: Node reset - descendants identified', { 
        nodeId,
        descendantsCount: nodesToRemove.size,
        descendants: Array.from(nodesToRemove)
      });

      const newState = {
        nodes: state.nodes.map(node => 
          node.id === nodeId 
            ? { ...node, data: { ...node.data, chatHistory: [], label: 'New Chat' } }
            : node
        ).filter(node => !nodesToRemove.has(node.id)),
        edges: state.edges.filter(edge => 
          !nodesToRemove.has(edge.target) && !nodesToRemove.has(edge.source)
        ),
      };

      logger.info('ChatStore: Node reset completed', { 
        nodeId,
        removedDescendants: nodesToRemove.size,
        remainingNodes: newState.nodes.length,
        remainingEdges: newState.edges.length
      });

      return newState;
    });
    
    // Save to storage after node reset
    get().saveToStorage();
  },

  addMessageToNode: (nodeId, message, isPartial = false) => {
    logger.debug('ChatStore: Adding message to node', { 
      nodeId, 
      messageRole: message.role,
      messageLength: message.content.length,
      messagePreview: message.content.substring(0, 50) + (message.content.length > 50 ? '...' : ''),
      hasAttachments: !!message.attachments?.length,
      attachmentsCount: message.attachments?.length || 0,
      isPartial
    });

    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id === nodeId) {
          const lastMessage = node.data.chatHistory[node.data.chatHistory.length - 1];
          const isSameRole = lastMessage?.role === message.role;
          
          logger.debug('ChatStore: Processing message addition', { 
            nodeId,
            hasLastMessage: !!lastMessage,
            lastMessageRole: lastMessage?.role,
            isSameRole,
            currentHistoryLength: node.data.chatHistory.length
          });
          
          const updatedChatHistory =
            isPartial && isSameRole
              ? node.data.chatHistory.map((msg: ChatMessage, idx: number) =>
                  idx === node.data.chatHistory.length - 1
                    ? { ...msg, content: message.content } // Keep attachments from original message
                    : msg
                )
              : [...node.data.chatHistory, message];

          logger.debug('ChatStore: Chat history updated', { 
            nodeId,
            previousLength: node.data.chatHistory.length,
            newLength: updatedChatHistory.length,
            wasPartialUpdate: isPartial && isSameRole
          });

          // Generate a new title when we get a model response
          if (message.role === 'model' && !isPartial && state.chatManager) {
            logger.debug('ChatStore: Generating new title for node', { nodeId });
            
            // Use the last few messages for context
            const recentMessages = updatedChatHistory.slice(-4);
            state.chatManager.generateTitle(recentMessages).then(newTitle => {
              logger.info('ChatStore: New title generated', { 
                nodeId, 
                newTitle,
                basedOnMessages: recentMessages.length
              });

              set(state => ({
                nodes: state.nodes.map(n => 
                  n.id === nodeId 
                    ? { ...n, data: { ...n.data, label: newTitle } }
                    : n
                )
              }));
              
              // Save to storage after title update
              get().saveToStorage();
            }).catch(error => {
              logger.error('ChatStore: Title generation failed', { 
                nodeId, 
                error: error instanceof Error ? error.message : error 
              });
              
              // Fallback to simple title
              const fallbackTitle = message.content.substring(0, 30) + (message.content.length > 30 ? '...' : '');
              logger.debug('ChatStore: Using fallback title', { nodeId, fallbackTitle });
              
              set(state => ({
                nodes: state.nodes.map(n => 
                  n.id === nodeId 
                    ? { ...n, data: { ...n.data, label: fallbackTitle } }
                    : n
                )
              }));
              
              // Save to storage after fallback title
              get().saveToStorage();
            });
          }

          return {
            ...node,
            data: {
              ...node.data,
              chatHistory: updatedChatHistory,
            },
          };
        }
        return node;
      }),
    }));
    
    // Save to storage after adding message (but not for partial updates to avoid too many saves)
    if (!isPartial) {
      get().saveToStorage();
    }
  },

  removeLastMessageFromNode: (nodeId) => {
    logger.info('ChatStore: Removing last message from node', { nodeId });

    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id === nodeId) {
          const updatedChatHistory = node.data.chatHistory.slice(0, -1);
          
          logger.debug('ChatStore: Message removed from node', { 
            nodeId,
            previousLength: node.data.chatHistory.length,
            newLength: updatedChatHistory.length
          });

          return {
            ...node,
            data: {
              ...node.data,
              chatHistory: updatedChatHistory,
            },
          };
        }
        return node;
      }),
    }));
    
    // Save to storage after removing message
    get().saveToStorage();
  },

  updateLastMessageInNode: (nodeId, content, modelId) => {
    logger.debug('ChatStore: Updating last message in node', { 
      nodeId, 
      contentLength: content.length,
      modelId
    });

    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id === nodeId && node.data.chatHistory.length > 0) {
          const chatHistory = [...node.data.chatHistory];
          const lastMessage = chatHistory[chatHistory.length - 1];
          
          // Only update if it's a model message and matches the expected model
          if (lastMessage.role === 'model' && (!modelId || (lastMessage as any).modelId === modelId)) {
            chatHistory[chatHistory.length - 1] = {
              ...lastMessage,
              content
            };
            
            logger.debug('ChatStore: Last message updated', { 
              nodeId,
              contentLength: content.length,
              messageIndex: chatHistory.length - 1
            });
            
            return {
              ...node,
              data: {
                ...node.data,
                chatHistory,
              },
            };
          }
        }
        return node;
      }),
    }));
    
    // Don't save to session during streaming updates to avoid performance issues
  },

  createNodeAndEdge: (sourceNodeId, label, type) => {
    logger.info('ChatStore: Creating new node and edge', { 
      sourceNodeId, 
      label, 
      type 
    });

    const sourceNode = get().nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode) {
      logger.error('ChatStore: Source node not found', { sourceNodeId });
      return '';
    }

    const newNodeId = nanoid();
    const newX = sourceNode.position.x + (type === 'branch' ? 350 : 0);
    const newY = sourceNode.position.y + 250;

    logger.debug('ChatStore: New node configuration', { 
      newNodeId,
      sourcePosition: sourceNode.position,
      newPosition: { x: newX, y: newY },
      type
    });

    // Get conversation history up to source node for document inheritance
    const pathToSource = get().getPathToNode(sourceNodeId);
    
    // Extract all documents from the conversation path for inheritance
    const inheritedDocuments = pathToSource.reduce((docs: AttachmentData[], msg) => {
      if (msg.attachments) {
        msg.attachments.forEach(att => {
          // Only inherit document types
          const isDocument = att.type === 'application/pdf' || 
                            att.type.startsWith('text/') || 
                            att.type.includes('javascript') || 
                            att.type.includes('python');
          
          if (isDocument) {
            const docKey = `${att.name}:${att.type}`;
            const alreadyExists = docs.some(doc => `${doc.name}:${doc.type}` === docKey);
            
            if (!alreadyExists) {
              docs.push({
                name: att.name,
                type: att.type,
                data: att.data,
                previewUrl: att.previewUrl
              });
              
              logger.debug('ChatStore: Document inherited for new branch', {
                sourceNodeId,
                newNodeId,
                fileName: att.name,
                fileType: att.type
              });
            }
          }
        });
      }
      return docs;
    }, []);

    logger.info('ChatStore: Document inheritance for branch', {
      sourceNodeId,
      newNodeId,
      inheritedDocumentsCount: inheritedDocuments.length,
      documentNames: inheritedDocuments.map(d => d.name)
    });

    const newNode: Node<CustomNodeData> = {
      id: newNodeId,
      type: 'chatNode',
      data: { 
        label, 
        chatHistory: type === 'branch' ? [] : [] // Branch starts empty but will inherit documents via ChatManager
      },
      position: { x: newX, y: newY },
    };

    const newEdge: Edge = {
      id: `e-${sourceNodeId}-${newNodeId}`,
      source: sourceNodeId,
      target: newNodeId,
      markerEnd: { type: MarkerType.ArrowClosed },
    };

    set((state) => {
      const newState = {
        nodes: [...state.nodes, newNode],
        edges: addEdge(newEdge, state.edges),
      };

      logger.info('ChatStore: Node and edge created successfully', { 
        newNodeId,
        edgeId: newEdge.id,
        totalNodes: newState.nodes.length,
        totalEdges: newState.edges.length
      });

      // If we have a chat manager and this is a branch, set up document inheritance
      if (type === 'branch' && state.chatManager) {
        logger.info('ChatStore: Setting up branch thread with document inheritance', {
          sourceNodeId,
          newNodeId,
          pathToSourceLength: pathToSource.length
        });
        
        // Create branch thread with document inheritance
        state.chatManager.createBranchThread(sourceNodeId, newNodeId, pathToSource);
      }

      return newState;
    });

    // Save to storage after creating node and edge
    get().saveToStorage();
    
    return newNodeId;
  },

  getPathNodeIds: (targetNodeId) => {
    logger.debug('ChatStore: Getting path node IDs', { targetNodeId });

    const { edges } = get();
    const path: string[] = [];
    let currentId: string | undefined = targetNodeId;
    
    // Build map of target -> source relationships
    const incoming = new Map<string, string>();
    edges.forEach((edge) => {
      incoming.set(edge.target, edge.source);
    });
    
    logger.debug('ChatStore: Built incoming edge map', { 
      targetNodeId,
      incomingMapSize: incoming.size
    });
    
    // Traverse up the tree to root
    while (currentId) {
      path.unshift(currentId);
      currentId = incoming.get(currentId);
      if (!currentId) break;
    }
    
    logger.debug('ChatStore: Path to node calculated', { 
      targetNodeId,
      pathLength: path.length,
      path
    });
    
    return path;
  },

  getPathEdgeIds: (targetNodeId) => {
    logger.debug('ChatStore: Getting path edge IDs', { targetNodeId });

    const { edges } = get();
    const nodeIds = get().getPathNodeIds(targetNodeId);
    const edgeIds: string[] = [];
    
    // Find all edges connecting nodes in the path
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const sourceId = nodeIds[i];
      const targetId = nodeIds[i + 1];
      
      const edge = edges.find(e => e.source === sourceId && e.target === targetId);
      if (edge) {
        edgeIds.push(edge.id);
        logger.debug('ChatStore: Edge found in path', { 
          sourceId, 
          targetId, 
          edgeId: edge.id 
        });
      }
    }
    
    logger.debug('ChatStore: Path edges calculated', { 
      targetNodeId,
      pathEdgesCount: edgeIds.length,
      edgeIds
    });
    
    return edgeIds;
  },

  getPathToNode: (targetNodeId) => {
    logger.debug('ChatStore: Getting conversation path to node', { targetNodeId });

    const { nodes } = get();
    const pathNodeIds = get().getPathNodeIds(targetNodeId);
    const pathMessages: ChatMessage[] = [];
    
    logger.debug('ChatStore: Processing path nodes for messages', { 
      targetNodeId,
      pathNodesCount: pathNodeIds.length,
      pathNodeIds
    });
    
    // Collect messages from all nodes in the path, maintaining conversation context
    pathNodeIds.forEach((id, index) => {
      const node = nodes.find(n => n.id === id);
      if (node?.data.chatHistory) {
        logger.debug('ChatStore: Processing node messages', { 
          nodeId: id,
          nodeIndex: index,
          messagesCount: node.data.chatHistory.length,
          nodeLabel: node.data.label
        });

        // Include all messages from this node, preserving attachments
        node.data.chatHistory.forEach((msg, msgIndex) => {
          pathMessages.push({
            role: msg.role,
            content: msg.content,
            attachments: msg.attachments || []
          });
          
          logger.debug('ChatStore: Message added to path', { 
            nodeId: id,
            messageIndex: msgIndex,
            messageRole: msg.role,
            messageLength: msg.content.length,
            hasAttachments: !!msg.attachments?.length
          });
        });
      } else {
        logger.debug('ChatStore: Node has no chat history', { nodeId: id });
      }
    });
    
    logger.info('ChatStore: Conversation path assembled', { 
      targetNodeId,
      totalMessages: pathMessages.length,
      messagesBreakdown: pathMessages.reduce((acc, msg) => {
        acc[msg.role] = (acc[msg.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      totalAttachments: pathMessages.reduce((sum, msg) => sum + (msg.attachments?.length || 0), 0)
    });
    
    return pathMessages;
  },

  deleteNodeAndDescendants: (nodeId) => {
    logger.info('ChatStore: Deleting node and descendants', { nodeId });

    set((state) => {
      if (nodeId === 'root') {
        logger.warn('ChatStore: Cannot delete root node', { nodeId });
        return state;
      }
      
      // Find all descendants
      const nodesToRemove = new Set<string>([nodeId]);
      const queue = [nodeId];
      
      while (queue.length > 0) {
        const currentId = queue.shift()!;
        state.edges.forEach((edge) => {
          if (edge.source === currentId) {
            if (!nodesToRemove.has(edge.target)) {
              nodesToRemove.add(edge.target);
              queue.push(edge.target);
              logger.debug('ChatStore: Descendant found for deletion', { 
                parentId: currentId, 
                descendantId: edge.target 
              });
            }
          }
        });
      }
      
      logger.info('ChatStore: All descendants identified for deletion', { 
        nodeId,
        totalNodesToDelete: nodesToRemove.size,
        nodeIds: Array.from(nodesToRemove)
      });
      
      // Clean up chat threads for removed nodes
      nodesToRemove.forEach(id => {
        state.chatManager?.deleteThread(id);
        logger.debug('ChatStore: Chat thread deleted for node', { nodeId: id });
      });
      
      const newState = {
        nodes: state.nodes.filter((node) => !nodesToRemove.has(node.id)),
        edges: state.edges.filter((edge) => !nodesToRemove.has(edge.source) && !nodesToRemove.has(edge.target)),
      };

      logger.info('ChatStore: Node deletion completed', { 
        nodeId,
        deletedNodes: nodesToRemove.size,
        remainingNodes: newState.nodes.length,
        remainingEdges: newState.edges.length
      });

      return newState;
    });
    
    // Save to storage after node deletion
    get().saveToStorage();
  },

  setActiveNodeId: (nodeId) => {
    logger.info('ChatStore: Setting active node', { 
      previousActiveNodeId: get().activeNodeId,
      newActiveNodeId: nodeId
    });

    if (!nodeId) {
      logger.debug('ChatStore: Clearing active node');
      set({ 
        activeNodeId: null,
        activePath: { nodeIds: [], edgeIds: [] }
      });
      get().saveToStorage();
      return;
    }
    
    const nodeIds = get().getPathNodeIds(nodeId);
    const edgeIds = get().getPathEdgeIds(nodeId);
    
    logger.debug('ChatStore: Active path calculated', { 
      activeNodeId: nodeId,
      pathNodesCount: nodeIds.length,
      pathEdgesCount: edgeIds.length
    });
    
    set({ 
      activeNodeId: nodeId,
      activePath: { nodeIds, edgeIds }
    });

    logger.info('ChatStore: Active node set successfully', { 
      activeNodeId: nodeId,
      activePath: { nodeIds, edgeIds }
    });
    
    // Save to storage when active node changes
    get().saveToStorage();
  },

  // Workspace management methods
  getCurrentWorkspace: () => {
    return workspaceManager.getActiveWorkspace();
  },

  switchWorkspace: (workspaceId: string) => {
    try {
      // Save current workspace before switching
      const currentState = get();
      const currentWorkspaceId = workspaceManager.getActiveWorkspaceId();
      
      if (currentWorkspaceId !== workspaceId) {
        // Save current workspace data
        const workspaceData = {
          name: workspaceManager.getActiveWorkspace()?.name || 'Current Workspace',
          nodes: currentState.nodes,
          edges: currentState.edges,
          activeNodeId: currentState.activeNodeId,
          timestamp: Date.now(),
          version: STORAGE_VERSION,
          metadata: {
            totalMessages: currentState.nodes.reduce((sum, node) => 
              sum + (node.data?.chatHistory?.length || 0), 0
            ),
            totalAttachments: currentState.nodes.reduce((sum, node) => 
              sum + (node.data?.chatHistory?.reduce((msgSum: number, msg: any) => 
                msgSum + (msg.attachments?.length || 0), 0) || 0), 0
            ),
            createdAt: Date.now(),
            lastModified: Date.now(),
            dataSize: 0
          }
        };
        
        workspaceManager.saveWorkspaceData(currentWorkspaceId, workspaceData);
        
        // Switch to new workspace
        workspaceManager.setActiveWorkspace(workspaceId);
        
        // Load new workspace data
        const newWorkspaceData = workspaceManager.getWorkspaceData(workspaceId);
        if (newWorkspaceData) {
          // Ensure root node exists
          const hasRoot = newWorkspaceData.nodes.some(node => node.id === 'root');
          if (!hasRoot) {
            newWorkspaceData.nodes.unshift(ROOT_NODE);
          }

          set({
            nodes: newWorkspaceData.nodes,
            edges: newWorkspaceData.edges,
            activeNodeId: newWorkspaceData.activeNodeId || 'root',
            activePath: {
              nodeIds: newWorkspaceData.activeNodeId ? 
                get().getPathNodeIds(newWorkspaceData.activeNodeId) : ['root'],
              edgeIds: newWorkspaceData.activeNodeId ? 
                get().getPathEdgeIds(newWorkspaceData.activeNodeId) : []
            }
          });
        } else {
          // Initialize with default state if no data
          set({
            nodes: [ROOT_NODE],
            edges: [],
            activeNodeId: 'root',
            activePath: { nodeIds: ['root'], edgeIds: [] }
          });
        }
        
        logger.info('ChatStore: Switched to workspace', { workspaceId });
        return true;
      }
      
      return true;
    } catch (error) {
      logger.error('ChatStore: Failed to switch workspace', { workspaceId, error });
      return false;
    }
  },

  createNewWorkspace: (name: string) => {
    try {
      const workspaceId = workspaceManager.createWorkspace(name);
      logger.info('ChatStore: Created new workspace', { workspaceId, name });
      return workspaceId;
    } catch (error) {
      logger.error('ChatStore: Failed to create workspace', { name, error });
      return '';
    }
  },

  renameCurrentWorkspace: (newName: string) => {
    try {
      const currentWorkspace = workspaceManager.getActiveWorkspace();
      if (!currentWorkspace) return false;
      
      const success = workspaceManager.renameWorkspace(currentWorkspace.id, newName);
      if (success) {
        logger.info('ChatStore: Renamed current workspace', { 
          workspaceId: currentWorkspace.id, 
          newName 
        });
      }
      return success;
    } catch (error) {
      logger.error('ChatStore: Failed to rename workspace', { newName, error });
      return false;
    }
  },

  deleteWorkspace: (workspaceId: string) => {
    try {
      const success = workspaceManager.deleteWorkspace(workspaceId);
      if (success) {
        logger.info('ChatStore: Deleted workspace', { workspaceId });
      }
      return success;
    } catch (error) {
      logger.error('ChatStore: Failed to delete workspace', { workspaceId, error });
      return false;
    }
  },
})); 